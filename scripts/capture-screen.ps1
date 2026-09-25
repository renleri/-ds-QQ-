# 截取当前屏幕（所有显示器拼成的虚拟桌面），缩放到指定宽度后存成 JPEG。
# 只用在「让鲸鱼娘看看主人在干什么」这一个用途上，输出固定落在 state/ 目录下。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-screen.ps1 -Out "D:\...\state\screen.jpg"
#   powershell ... -File capture-screen.ps1 -Probe        # 只回报前台窗口标题，不截图
#
# 为什么加了 -Probe 和窗口标题（2026-09-25）：
#   她反馈过三个真问题：①同一画面反复触发主动唤醒；②截图拍到设置页（含真人姓名/邮箱）
#   和 DSH 控制台本身；③凌晨截图全黑还唤醒。要按「窗口 + 时间窗」去重、要按窗口标题
#   拉黑，就必须先知道**前台窗口是什么** —— 所以脚本把标题一起回报。
#   标题用 base64(UTF-8) 传，避免中文/空格/竖线把解析搞乱。
#
# 注意：
# - 需要**有交互桌面的登录会话**。锁屏 / 远程断开的会话可能截到黑屏。
# - 多显示器时按虚拟桌面整体截取（VirtualScreen 可能是负坐标，已处理）。
param(
  [string]$Out = '',
  [int]$MaxWidth = 1100,
  [int]$Quality = 55,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-B64([string]$text) {
  if (-not $text) { return '' }
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
}

# ── 前台窗口标题 ────────────────────────────────────────────────────────
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WhaleWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  public static string Title() {
    try {
      IntPtr h = GetForegroundWindow();
      int len = GetWindowTextLengthW(h);
      if (len <= 0) return "";
      StringBuilder sb = new StringBuilder(len + 2);
      GetWindowTextW(h, sb, sb.Capacity);
      return sb.ToString();
    } catch { return ""; }
  }
}
"@

$fgTitle = ''
try { $fgTitle = [WhaleWin]::Title() } catch { $fgTitle = '' }

if ($Probe) {
  "TITLE $(Get-B64 $fgTitle)"
  exit 0
}

if (-not $Out) { throw '需要 -Out 指定输出路径（或用 -Probe 只读窗口标题）' }

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
# win= 是 base64(UTF-8) 的前台窗口标题，调用方用它做「同窗口去重」和「窗口黑名单」
"OK $Out $outW x $outH (raw $($vs.Width)x$($vs.Height), dpi=$dpiMode) win=$(Get-B64 $fgTitle)"
