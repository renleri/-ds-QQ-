# 小鲸鱼 QQ 桥接 · 一键启动
#
# 为什么逻辑放在 PowerShell 而不是 .bat：
#   cmd.exe 对 UTF-8 的中文/emoji/制表符解析不可靠（实测：脚本能启动桥接，但一行 echo
#   都没输出、尾部行为异常）。PowerShell 对 UTF-8 稳定，且能直接做端口/进程/HTTP 判断。
#   start-all.bat 因此只留纯 ASCII，负责把控制权交给本文件。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-all.ps1
#   powershell ... -File scripts\start-all.ps1 -DryRun        # 只体检，不杀进程/不启动
#   powershell ... -File scripts\start-all.ps1 -SkipSnowluma  # 不检查 SnowLuma
param(
  [switch]$DryRun,
  [switch]$SkipSnowluma,
  [int]$SnowlumaWaitSeconds = 40
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot   # scripts\ -> qq-bridge\
Set-Location $root
try { $Host.UI.RawUI.WindowTitle = '小鲸鱼 QQ 桥接' } catch { }

$SNOWLUMA_DIR = 'C:\Users\17735\Desktop\suno'
$LOCK = Join-Path $root 'state\bridge.lock'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Test-Port([int]$port) {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $port)
    $client.Close()
    return $true
  } catch { return $false }
}

# 所有 SnowLuma 进程（node 跑 index.mjs 的）
function Get-SnowlumaProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*index.mjs*' })
}

# 真正调一次 OneBot，而不是只看端口是否在监听。
# 这一步很关键：SnowLuma 卡死时端口照样 LISTENING，光看端口会误判成"健康"，
# 于是桥接一直跟僵尸说话、每次发送都超时（The operation was aborted due to timeout）。
function Test-OneBotHealthy {
  $token = ''
  try {
    $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
    if ($cfg.snowluma.httpAccessToken) { $token = $cfg.snowluma.httpAccessToken }
    elseif ($cfg.snowluma.accessToken) { $token = $cfg.snowluma.accessToken }
  } catch { }
  if (-not (Test-Port 3000)) { return $false }
  try {
    $headers = @{ 'content-type' = 'application/json' }
    if ($token) { $headers['authorization'] = "Bearer $token" }
    $res = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post `
      -Headers $headers -Body '{}' -TimeoutSec 6
    return ($res.status -eq 'ok')
  } catch { return $false }
}

function Stop-SnowlumaProcesses([object[]]$procs) {
  foreach ($p in $procs) {
    Say "        结束 SnowLuma PID=$($p.ProcessId)" 'Yellow'
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
}

function Start-SnowlumaOnce {
  $launcher = Join-Path $SNOWLUMA_DIR 'launcher.bat'
  if (-not (Test-Path $launcher)) { return $false }
  # 隐藏启动：SnowLuma 不需要人看，多开一个黑窗口只会让人误关（关掉它就等于杀掉网关）。
  # 全程只留桥接那一个可见窗口。
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'launcher.bat' `
    -WorkingDirectory $SNOWLUMA_DIR -WindowStyle Hidden
  return $true
}

Write-Host ''
Say '  🐋 小鲸鱼 QQ 桥接 · 一键启动' 'Cyan'
Say '  ════════════════════════════════════════════' 'DarkGray'
if ($DryRun) { Say '  【DryRun 模式】只体检，不结束进程、不启动桥接' 'Magenta' }

# ── 1/3 SnowLuma ────────────────────────────────────────────────────
Say '  [1/3] 检查 SnowLuma 网关（127.0.0.1:3001）...'
if ($SkipSnowluma) {
  Say '        已跳过（-SkipSnowluma）' 'DarkGray'
} else {
  $instances = Get-SnowlumaProcesses
  $healthy = Test-OneBotHealthy

  if ($healthy -and $instances.Count -le 1) {
    Say '        已在运行，OneBot 响应正常 ✓' 'Green'
  } elseif ($healthy) {
    # 健康但有多个实例：多余的抢不到端口，只会在日志里刷 "port in use"，清掉
    Say "        OneBot 正常，但有 $($instances.Count) 个 SnowLuma 实例，清理多余的..." 'Yellow'
    $keeperId = $null
    $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { $keeperId = $conn.OwningProcess }
    $extras = @($instances | Where-Object { $_.ProcessId -ne $keeperId })
    if ($DryRun) { Say "        [DryRun] 会结束多余的 $($extras.Count) 个实例" 'Magenta' }
    else { Stop-SnowlumaProcesses $extras; Say '        多余实例已清理 ✓' 'Green' }
  } else {
    # 不健康：要么没跑，要么是「端口在监听但 API 不响应」的僵尸实例
    if ($instances.Count -gt 0) {
      Say "        检测到 $($instances.Count) 个 SnowLuma 进程，但 OneBot 无响应（僵尸实例）" 'Yellow'
      if ($DryRun) { Say '        [DryRun] 会全部结束并重启一个干净的实例' 'Magenta' }
      else { Stop-SnowlumaProcesses $instances }
    } else {
      Say '        未运行' 'Yellow'
    }

    if ($DryRun) {
      Say "        [DryRun] 会启动：$SNOWLUMA_DIR\launcher.bat" 'Magenta'
    } elseif (Start-SnowlumaOnce) {
      Say "        等待网关就绪（最多 $SnowlumaWaitSeconds 秒）..."
      $ready = $false
      for ($i = 0; $i -lt $SnowlumaWaitSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (Test-OneBotHealthy) { $ready = $true; Say "        SnowLuma 就绪 ✓（第 $($i + 1) 秒）" 'Green'; break }
      }
      if (-not $ready) { Say '        [警告] 等待超时，仍继续启动桥接（可能连不上 QQ）' 'Yellow' }
    } else {
      Say '        [警告] 找不到 SnowLuma 启动脚本：' 'Yellow'
      Say "               $SNOWLUMA_DIR\launcher.bat" 'Yellow'
    }
  }
}

# ── 2/3 接管旧实例 ──────────────────────────────────────────────────
# 故意不用「命令行文本匹配」杀进程：DSH 沙箱 runner 的命令行会把脚本正文整段嵌进去，
# 像 *bridge.js* 这种宽松匹配会误杀无关进程（实测踩过）。
# 改为读 state\bridge.lock 里的 PID，并二次校验进程名必须是 node.exe，才结束它。
Say '  [2/3] 检查是否有旧实例...'
if (-not (Test-Path $LOCK)) {
  Say '        没有旧实例 ✓' 'Green'
} else {
  $target = ''
  try { $target = (Get-Content $LOCK -Raw -ErrorAction Stop).Trim() } catch { }
  if ($target -notmatch '^\d+$') {
    Say '        锁文件内容不是 PID，只清理锁。' 'DarkGray'
  } else {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq 'node.exe') {
      if ($DryRun) {
        Say "        [DryRun] 会结束旧实例 PID=$target（node.exe）" 'Magenta'
      } else {
        Say "        发现旧实例 PID=$target，正在结束..." 'Yellow'
        Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
      }
    } elseif ($proc) {
      Say "        PID=$target 是 $($proc.Name) 而非 node.exe，不动它（陈旧锁）。" 'DarkGray'
    } else {
      Say "        锁里的 PID=$target 已不存在（陈旧锁）。" 'DarkGray'
    }
  }
  if (-not $DryRun) { Remove-Item $LOCK -Force -ErrorAction SilentlyContinue }
}

if ($DryRun) {
  Write-Host ''
  Say '  【DryRun 结束】以上为真实运行时会执行的动作。' 'Magenta'
  exit 0
}

# ── 3/3 启动桥接（守护循环） ────────────────────────────────────────
Say '  [3/3] 启动桥接（本窗口保持打开；退出后 5 秒自动重启）' 'Cyan'
Say '  ════════════════════════════════════════════' 'DarkGray'
Write-Host ''

while ($true) {
  & node 'src\bridge.js'
  $code = $LASTEXITCODE
  Write-Host ''
  if ($code -eq 2) {
    Say '  桥接已在另一个窗口运行，本窗口退出。' 'Yellow'
    Read-Host '  按回车关闭'
    exit 2
  }
  Say "  桥接退出（code $code），5 秒后自动重启..." 'Yellow'
  Start-Sleep -Seconds 5
}
