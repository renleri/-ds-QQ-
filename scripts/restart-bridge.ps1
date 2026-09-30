# 重启 QQ 桥接（分离进程版）—— 供 harness / 终端里的自动化调用。
#
# ⚠️ 为什么不能用 Start-Process（2026-09-30 实测踩到）：
#   在 DSH harness 里执行本脚本时，命令跑在一个 Windows Job 里，
#   Start-Process 出来的子进程**属于该 Job**，命令结束、Job 关闭时会被连带回收。
#   症状极具迷惑性：桥接正常启动、跑了约 5 分钟、然后日志凭空停止，
#   没有任何崩溃/异常痕迹（因为它是被内核结束的）。
#   所以改用 WMI Win32_Process.Create 启动 —— 新进程不属于当前 Job，命令结束后继续存活。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-bridge.ps1
#   powershell ... -File scripts\restart-bridge.ps1 -WaitSeconds 90
param(
  [int]$WaitSeconds = 60,
  [switch]$NoStop
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot          # qq-bridge/
$Lock = Join-Path $Root 'state\bridge.lock'
$Log = Join-Path $Root 'state\bridge.log'
$NodeExe = 'C:\Program Files\nodejs\node.exe'

function Say([string]$Text, [string]$Color = 'Gray') {
  Write-Host "  $Text" -ForegroundColor $Color
}

Write-Host ''
Say '🐋 重启 QQ 桥接（分离进程版）' 'Cyan'
Say '────────────────────────────────────────────' 'DarkGray'

# ── 1. 停掉旧实例 ────────────────────────────────────────────────────────────
# 只认 state\bridge.lock 里的 PID，并二次校验「进程名是 node.exe」——
# 不做命令行文本匹配：harness 的沙箱 runner 会把脚本正文整段塞进命令行，宽松匹配会误杀。
if (-not $NoStop -and (Test-Path $Lock)) {
  $target = ''
  try { $target = (Get-Content $Lock -Raw -ErrorAction Stop).Trim() } catch { }
  if ($target -match '^\d+$') {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq 'node.exe') {
      Say "结束旧实例 PID=$target" 'Yellow'
      Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    } elseif ($proc) {
      Say "锁里的 PID=$target 是 $($proc.Name)（不是 node.exe），不动它" 'DarkGray'
    } else {
      Say "锁里的 PID=$target 已不存在（陈旧锁）" 'DarkGray'
    }
  }
  Remove-Item $Lock -Force -ErrorAction SilentlyContinue
} else {
  Say '没有旧实例需要结束' 'DarkGray'
}

# ── 2. 用 WMI 启动（关键：脱离当前 Job）─────────────────────────────────────
if (-not (Test-Path $NodeExe)) { throw "找不到 node.exe：$NodeExe" }
$cmd = "cmd.exe /c cd /d `"$Root`" && `"$NodeExe`" src\bridge.js"
$before = if (Test-Path $Log) { (Get-Item $Log).LastWriteTime } else { [datetime]::MinValue }

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($result.ReturnValue -ne 0) { throw "WMI 启动失败，ReturnValue=$($result.ReturnValue)" }
Say "已启动（外层 cmd PID=$($result.ProcessId)，node 子进程随后写入 state\bridge.lock）" 'Green'

# ── 3. 等它就绪 ─────────────────────────────────────────────────────────────
# 就绪判据：日志出现新内容 + 控制台端口 3100 能连上（比只看进程更接近"真的能用"）。
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $logNew = (Test-Path $Log) -and ((Get-Item $Log).LastWriteTime -gt $before)
  $portOk = $false
  try {
    $portOk = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3100 -InformationLevel Quiet -WarningAction SilentlyContinue)
  } catch { }
  if ($logNew -and $portOk) { $ready = $true; break }
}

if ($ready) {
  $lockPid = if (Test-Path $Lock) { (Get-Content $Lock -Raw).Trim() } else { '(未写)' }
  Say "桥接已就绪 ✓（控制台 3100 可连，state\bridge.lock = $lockPid）" 'Green'
  Say '注意：这个进程已脱离当前 Job，本命令结束后它会继续运行。' 'DarkGray'
} else {
  Say "等待 $WaitSeconds 秒后仍未就绪 ✗ —— 看日志尾部：" 'Red'
  if (Test-Path $Log) { Get-Content $Log -Tail 12 | ForEach-Object { Say "    $_" 'DarkGray' } }
  exit 1
}
