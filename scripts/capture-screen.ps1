# 截取当前屏幕（所有显示器拼成的虚拟桌面），缩放到指定宽度后存成 JPEG。
# 只用在「让鲸鱼娘看看主人在干什么」这一个用途上，输出固定落在 state/ 目录下。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-screen.ps1 -Out "D:\...\state\screen.jpg"
#
# 注意：
# - 需要**有交互桌面的登录会话**。锁屏 / 远程断开的会话可能截到黑屏。
# - 多显示器时按虚拟桌面整体截取（VirtualScreen 可能是负坐标，已处理）。
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 1100,
  [int]$Quality = 55
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 关键：先声明 DPI 感知 ────────────────────────────────────────────────
# 不声明的话，进程看到的是「逻辑分辨率」：2560x1440 的屏在 150% 缩放下只量到 1707x960，
# CopyFromScreen 于是只抓到左上角那一块——表现就是「截图只截了半屏」。
# 优先 Per-Monitor V2（多屏不同缩放也对），失败再退回旧 API。
Add-Type @"
using System.Runtime.InteropServices;
public class WhaleDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
$dpiMode = 'none'
try {
  if ([WhaleDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpiMode = 'per-monitor-v2' }
  elseif ([WhaleDpi]::SetProcessDPIAware()) { $dpiMode = 'system-aware' }
} catch {
  try { if ([WhaleDpi]::SetProcessDPIAware()) { $dpiMode = 'system-aware' } } catch { }
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -le 0 -or $vs.Height -le 0) { throw '拿不到屏幕尺寸（可能没有交互桌面）' }

$full = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
try {
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $full.Size)
} finally {
  $g.Dispose()
}

# 等比缩放到 MaxWidth（本来就窄就不放大）
$scale = [Math]::Min(1.0, $MaxWidth / [double]$vs.Width)
$outW = [int][Math]::Round($vs.Width * $scale)
$outH = [int][Math]::Round($vs.Height * $scale)

$final = $full
if ($scale -lt 1.0) {
  $final = New-Object System.Drawing.Bitmap($outW, $outH)
  $g2 = [System.Drawing.Graphics]::FromImage($final)
  try {
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($full, 0, 0, $outW, $outH)
  } finally {
    $g2.Dispose()
  }
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$final.Save($Out, $codec, $encParams)

$final.Dispose()
if ($final -ne $full) { }
$full.Dispose()

# 只输出一行结果，方便调用方解析
# 带上原始虚拟桌面尺寸与 DPI 模式：排查「只截了半屏」这类问题时一眼能看出来
"OK $Out $outW x $outH (raw $($vs.Width)x$($vs.Height), dpi=$dpiMode)"
