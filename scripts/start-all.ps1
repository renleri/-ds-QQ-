# 小鲸鱼 QQ 桥接 · 一键启动
#
# 为什么逻辑放在 PowerShell 而不是 .bat：
#   cmd.exe 对 UTF-8 的中文/emoji/制表符解析不可靠（实测：脚本能启动桥接，但一行 echo
#   都没输出、尾部行为异常）。PowerShell 对 UTF-8 稳定，且能直接做端口/进程/HTTP 判断。
#   start-all.bat 因此只留纯 ASCII，负责把控制权交给本文件。
#
# 这份脚本的目标只有一句话：**重启之后，主人双击 DSH 和「小鲸鱼QQ桥接」，她就能用。**
#
# 2026-09-19 蓝屏事故后重写，修掉四个真实的坑（每个都实测踩过）：
#
#   坑 1（致命·编码）：PowerShell 5.1 的 `Get-Content -Raw` 默认按 ANSI(GBK) 解码，
#        而 config.json 是 UTF-8 —— 中文变乱码后 ConvertFrom-Json 直接抛
#        "Invalid array passed in, ',' expected"。结果：拿不到 OneBot token →
#        健康检查**永远失败** → 把好好的 SnowLuma 判成僵尸反复杀掉。
#        现在：所有配置读取都显式 -Encoding UTF8。
#
#   坑 2（致命·抢跑）：QQ 冷启动登录实测要 7 分钟（22:46:48 启动 → 22:53:45 才 listening），
#        旧版只等 40 秒就把「正在登录中」的实例当僵尸杀掉重启，
#        于是登录永远完不成（22:34/22:38/22:42/22:44/22:46 五次重启就是这么来的）。
#        现在：进程比 ZombieGraceSeconds 年轻就只等不杀；总等待默认 12 分钟，边等边报进度。
#
#   坑 3（危险·登错号）：SnowLuma 的 OneBot token 是**按账号**存放的
#        （config\onebot_<QQ>.json）。实测它可能登上主人的个人 QQ 而不是小鲸鱼，
#        此时用桥接那把 token 请求会得到 401。现在：把 401/账号不符单独识别出来，
#        明确指出「现在登的是谁、应该登谁」，并且**拒绝启动桥接**。
#
#   坑 4（体验）：需要扫码登录时旧版一声不吭。现在：自动打开 SnowLuma 控制台 +
#        写清「要你做什么」，登录完成后自动继续启动桥接，主人不用再点第二次。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-all.ps1
#   powershell ... -File scripts\start-all.ps1 -DryRun              # 只体检，不杀进程/不启动
#   powershell ... -File scripts\start-all.ps1 -SkipSnowluma        # 跳过 SnowLuma 检查
#   powershell ... -File scripts\start-all.ps1 -NoBrowser           # 需要登录时不自动开浏览器
#   powershell ... -File scripts\start-all.ps1 -SnowlumaWaitSeconds 60   # 缩短最长等待（调试用）
param(
  [switch]$DryRun,
  [switch]$SkipSnowluma,
  [switch]$NoBrowser,
  [switch]$Force,
  [int]$SnowlumaWaitSeconds = 720,
  [int]$ZombieGraceSeconds = 600
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

# UTF-8 读取（坑 1）。PowerShell 5.1 不指定编码就按 GBK 解，中文必坏。
function Read-Json([string]$path) {
  try { return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# ── 配置 ─────────────────────────────────────────────────────────────
$Cfg = Read-Json (Join-Path $root 'config.json')
$BotQQ = ''
if ($Cfg -and $Cfg.snowluma -and $Cfg.snowluma.botQQ) { $BotQQ = [string]$Cfg.snowluma.botQQ }

# 所有 SnowLuma 进程（node 跑 index.mjs 的）
function Get-SnowlumaProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*index.mjs*' })
}

# 真调一次 OneBot，而不是只看端口是否在监听。
# 只看端口会误判：SnowLuma 卡死/登错号时端口照样 LISTENING。
# 返回 status：ok / unauthorized（端口通但 token 对不上，通常是登错号）/ down
function Get-OneBotInfo {
  $result = @{ status = 'down'; uin = ''; nickname = ''; error = '' }
  $token = ''
  if ($Cfg -and $Cfg.snowluma) {
    if ($Cfg.snowluma.httpAccessToken) { $token = $Cfg.snowluma.httpAccessToken }
    elseif ($Cfg.snowluma.accessToken) { $token = $Cfg.snowluma.accessToken }
  }
  if (-not (Test-Port 3000)) { $result.error = '端口 3000 未监听'; return $result }
  try {
    $headers = @{ 'content-type' = 'application/json' }
    if ($token) { $headers['authorization'] = "Bearer $token" }
    $res = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post `
      -Headers $headers -Body '{}' -TimeoutSec 6
    if ($res.status -eq 'ok' -and $res.data) {
      $result.status = 'ok'
      $result.uin = [string]$res.data.user_id
      $result.nickname = [string]$res.data.nickname
    } else {
      $result.error = "OneBot 返回异常：$($res.status)"
    }
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) { $result.status = 'unauthorized'; $result.error = 'HTTP 401：token 与当前登录账号不匹配' }
    else { $result.error = "OneBot 请求失败：$($_.Exception.Message)" }
  }
  return $result
}

function Test-OneBotHealthy { return ((Get-OneBotInfo).status -eq 'ok') }

# 从 SnowLuma 自己的日志里读「当前实际登录的是哪个 QQ」。
# 为什么要这么绕：OneBot 的 token 是按账号配的，登错号时 HTTP 直接 401，
# 拿不到 get_login_info 的 user_id；而日志里一定写着 `self info: UIN=<数字>`。
function Get-SnowlumaActiveUin {
  try {
    $logDir = Join-Path $SNOWLUMA_DIR 'logs'
    $log = Get-ChildItem (Join-Path $logDir 'snowluma-*.log') -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $log) { return '' }
    $hits = Select-String -Path $log.FullName -Pattern 'self info: UIN=(\d+)' -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($hits -and $hits.Count -gt 0) { return $hits[$hits.Count - 1].Matches[0].Groups[1].Value }
  } catch { }
  return ''
}

function Get-SnowlumaWebuiPort {
  $rt = Read-Json (Join-Path $SNOWLUMA_DIR 'config\runtime.json')
  if ($rt -and $rt.webuiPort) { return [int]$rt.webuiPort }
  return 5099
}

$script:WebuiOpened = $false
function Show-LoginHelp([int]$webuiPort, [string]$reason = '') {
  Say ''
  Say '  ┌─ 需要你动手（就这一次）──────────────────────────────┐' 'Yellow'
  if ($reason) { Say "  │ $reason" 'Yellow' }
  Say "  │ 1. 浏览器打开：http://127.0.0.1:$webuiPort" 'Yellow'
  Say '  │ 2. 用你的 SnowLuma 控制台密码登录' 'Yellow'
  Say '  │ 3. 在账号页面，把「小鲸鱼」账号登录上去（可能要手机扫码）' 'Yellow'
  if ($BotQQ) { Say "  │    要登的是 QQ：$BotQQ" 'Yellow' }
  Say '  │ 登录完成后不用管这个窗口，它会自动接着启动桥接' 'Yellow'
  Say '  └──────────────────────────────────────────────────────┘' 'Yellow'
  if (-not $NoBrowser -and -not $script:WebuiOpened -and (Test-Port $webuiPort)) {
    try { Start-Process "http://127.0.0.1:$webuiPort"; $script:WebuiOpened = $true } catch { }
  }
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

$webuiPort = Get-SnowlumaWebuiPort
$snowlumaOk = $false
$accountWrong = $false

# ── 1/4 SnowLuma ────────────────────────────────────────────────────
Say '  [1/4] 检查 SnowLuma 网关（127.0.0.1:3000/3001）...'
if ($SkipSnowluma) {
  Say '        已跳过（-SkipSnowluma）' 'DarkGray'
  $snowlumaOk = $true
} else {
  $info = Get-OneBotInfo

  if ($info.status -eq 'ok' -and (-not $BotQQ -or $info.uin -eq $BotQQ)) {
    Say "        已在运行，OneBot 响应正常 ✓  （账号 $($info.uin) $($info.nickname)）" 'Green'
    $snowlumaOk = $true
  } elseif ($info.status -eq 'ok' -and $BotQQ -and $info.uin -ne $BotQQ) {
    $accountWrong = $true
    Say "        [危险] 当前登录的是 $($info.uin)（$($info.nickname)），不是小鲸鱼 $BotQQ" 'Red'
    Say '               为避免她用错号发言，已暂停启动桥接。' 'Red'
    Show-LoginHelp $webuiPort "需要在控制台里切换到小鲸鱼 $BotQQ"
  } elseif ($info.status -eq 'unauthorized') {
    $active = Get-SnowlumaActiveUin
    $accountWrong = $true
    Say '        [危险] OneBot 端口通，但 config.json 里的 accessToken 被拒绝（401）' 'Red'
    if ($active) { Say "               日志显示当前登录的账号是 $active，不是小鲸鱼 $BotQQ" 'Red' }
    else { Say '               通常意味着登录的不是 config.json 里配置的那个账号' 'Red' }
    Show-LoginHelp $webuiPort "需要登录小鲸鱼 $BotQQ（现在是别的号）"
  }

  if (-not $snowlumaOk -and -not $accountWrong -and $DryRun) {
    # DryRun：只报告现状，不进等待循环（避免把"等不到"误报成超时失败）
    $procs = Get-SnowlumaProcesses
    if ($procs.Count -eq 0) {
      Say "        [DryRun] 未运行；真实运行时会启动：$SNOWLUMA_DIR\launcher.bat" 'Magenta'
    } else {
      $oldest = ($procs | Sort-Object CreationDate | Select-Object -First 1).CreationDate
      $ageSec = [int]((Get-Date) - $oldest).TotalSeconds
      Say "        [DryRun] 有 $($procs.Count) 个进程、已运行 $([math]::Floor($ageSec / 60)) 分 $($ageSec % 60) 秒但未就绪" 'Magenta'
      if ($ageSec -lt $ZombieGraceSeconds) {
        Say "        [DryRun] 仍在登录宽限期内（$([math]::Floor($ZombieGraceSeconds / 60)) 分钟内不当僵尸杀），真实运行时会继续等" 'Magenta'
      } else {
        Say '        [DryRun] 超过宽限期，真实运行时会判定僵尸并重启一个干净的实例' 'Magenta'
      }
    }
  } elseif (-not $snowlumaOk -and -not $accountWrong) {
    $deadline = (Get-Date).AddSeconds($SnowlumaWaitSeconds)
    $lastNotice = (Get-Date).AddSeconds(-99)
    $killedOnce = $false
    $started = $false
    $hintShown = $false

    while ((Get-Date) -lt $deadline) {
      $info = Get-OneBotInfo
      if ($info.status -eq 'ok') {
        if (-not $BotQQ -or $info.uin -eq $BotQQ) {
          Say "        SnowLuma 就绪 ✓  （账号 $($info.uin) $($info.nickname)）" 'Green'
          $snowlumaOk = $true
          break
        }
        $accountWrong = $true
        Say "        [危险] 登录的是 $($info.uin)，不是小鲸鱼 $BotQQ" 'Red'
        Show-LoginHelp $webuiPort "需要在控制台里切换到小鲸鱼 $BotQQ"
        break
      }
      if ($info.status -eq 'unauthorized') {
        $active = Get-SnowlumaActiveUin
        $accountWrong = $true
        Say '        [危险] OneBot 拒绝了我们配置的 token（401）' 'Red'
        if ($active) { Say "               当前登录账号：$active；应该是：$BotQQ" 'Red' }
        Show-LoginHelp $webuiPort "需要登录小鲸鱼 $BotQQ（现在是别的号）"
        break
      }

      $procs = Get-SnowlumaProcesses
      if ($procs.Count -eq 0) {
        if (-not $started) {
          Say '        未运行，正在启动...' 'Yellow'
          if (Start-SnowlumaOnce) {
            $started = $true
            Say '        QQ 冷启动登录通常要 1~8 分钟（实测约 7 分钟），请让这个窗口开着。' 'DarkGray'
          } else {
            Say "        [警告] 找不到启动脚本：$SNOWLUMA_DIR\launcher.bat" 'Red'
            break
          }
        } elseif ((Get-Date).AddSeconds(-20) -gt $lastNotice) {
          Say '        等待 SnowLuma 进程出现...' 'DarkGray'
          $lastNotice = Get-Date
        }
      } else {
        # 有进程但不健康：区分「正在启动/登录」和「真僵尸」——
        # 这是旧版最致命的 bug：登录要几分钟，旧版 40 秒就把它杀了。
        $oldest = ($procs | Sort-Object CreationDate | Select-Object -First 1).CreationDate
        $ageSec = [int]((Get-Date) - $oldest).TotalSeconds
        if ($ageSec -lt $ZombieGraceSeconds) {
          if ((Get-Date).AddSeconds(-15) -gt $lastNotice) {
            Say "        正在启动/登录中（已 $([math]::Floor($ageSec / 60)) 分 $($ageSec % 60) 秒），继续等..." 'DarkGray'
            $lastNotice = Get-Date
          }
          if ($ageSec -gt 60 -and -not $hintShown -and (Test-Port $webuiPort)) {
            Show-LoginHelp $webuiPort '如果它一直不登录，可能需要你手动登录一次'
            $hintShown = $true
          }
        } elseif (-not $killedOnce) {
          Say "        $($procs.Count) 个进程超过 $([math]::Floor($ZombieGraceSeconds / 60)) 分钟仍未就绪，判定为僵尸实例，重启一个干净的" 'Yellow'
          Stop-SnowlumaProcesses $procs
          [void](Start-SnowlumaOnce)
          $started = $true
          $killedOnce = $true
        } elseif ((Get-Date).AddSeconds(-15) -gt $lastNotice) {
          Say '        重启后仍未就绪，继续等待...' 'DarkGray'
          $lastNotice = Get-Date
        }
      }
      Start-Sleep -Seconds 2
    }

    if (-not $snowlumaOk -and -not $accountWrong) {
      Say '        [超时] SnowLuma 一直没就绪，本次不启动桥接（避免连不上 QQ 空转）。' 'Red'
      Say "        排查：日志 $SNOWLUMA_DIR\logs\snowluma-$(Get-Date -Format 'yyyy-MM-dd').log" 'DarkGray'
      Say "              或手动打开 http://127.0.0.1:$webuiPort 看账号状态" 'DarkGray'
    }
  }

  # 健康但有多个实例：多余的抢不到端口，只会在日志里刷 "port in use"，清掉
  if ($snowlumaOk) {
    $procs = Get-SnowlumaProcesses
    if ($procs.Count -gt 1) {
      Say "        OneBot 正常，但有 $($procs.Count) 个 SnowLuma 实例，清理多余的..." 'Yellow'
      $keeperId = $null
      $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($conn) { $keeperId = $conn.OwningProcess }
      $extras = @($procs | Where-Object { $_.ProcessId -ne $keeperId })
      if ($DryRun) { Say "        [DryRun] 会结束多余的 $($extras.Count) 个实例" 'Magenta' }
      else { Stop-SnowlumaProcesses $extras; Say '        多余实例已清理 ✓' 'Green' }
    }
  }
}

# ── 2/4 DSH ─────────────────────────────────────────────────────────
Say '  [2/4] 检查 DeepSeek Harness（127.0.0.1:3080）...'
if (Test-Port 3080) {
  Say '        已就绪 ✓' 'Green'
} else {
  Say '        还没起来 —— 请双击桌面上的 dsh 图标' 'Yellow'
  Say '        （桥接会自动重连 DSH，不用重启这个窗口）' 'DarkGray'
}

# ── 3/4 接管旧实例 ──────────────────────────────────────────────────
# 故意不用「命令行文本匹配」杀进程：DSH 沙箱 runner 的命令行会把脚本正文整段嵌进去，
# 像 *bridge.js* 这种宽松匹配会误杀无关进程（实测踩过）。
# 改为读 state\bridge.lock 里的 PID，并二次校验进程名必须是 node.exe，才结束它。
Say '  [3/4] 检查是否有旧实例...'
$bridgeAlreadyRunning = $false
if (Test-Path $LOCK) {
  $target = ''
  try { $target = (Get-Content $LOCK -Raw -ErrorAction Stop).Trim() } catch { }
  if ($target -match '^\d+$') {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq 'node.exe') {
      if ((Test-Port 3100) -and -not $Force) {
        # 已经在别的窗口跑着 → 不要抢，告诉主人就行（restart.bat 会带 -Force 走下面这条路）
        Say "        桥接已在另一个窗口运行（PID=$target）" 'Green'
        $bridgeAlreadyRunning = $true
      } elseif ($DryRun) {
        Say "        [DryRun] 会结束旧实例 PID=$target（node.exe）" 'Magenta'
      } else {
        Say "        结束旧实例 PID=$target，启动新的..." 'Yellow'
        Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Say '        （如果另有一个桥接窗口开着，它检测到新实例后会自己退出）' 'DarkGray'
      }
    } elseif ($proc) {
      Say "        PID=$target 是 $($proc.Name) 而非 node.exe，不动它（陈旧锁）。" 'DarkGray'
    } else {
      Say "        锁里的 PID=$target 已不存在（陈旧锁）。" 'DarkGray'
    }
  } elseif ($target) {
    Say '        锁文件内容不是 PID，只清理锁。' 'DarkGray'
  }
  if (-not $DryRun -and -not $bridgeAlreadyRunning) { Remove-Item $LOCK -Force -ErrorAction SilentlyContinue }
} else {
  Say '        没有旧实例 ✓' 'Green'
}

if ($DryRun) {
  Write-Host ''
  Say '  【DryRun 结束】以上为真实运行时会执行的动作。' 'Magenta'
  exit 0
}

if ($bridgeAlreadyRunning) {
  Write-Host ''
  Say '  她已经在跑了，本窗口无事可做。' 'Green'
  Say '  （想重启桥接：关掉那个窗口再双击本图标，或用 qq-bridge\restart.bat）' 'DarkGray'
  Start-Sleep -Seconds 5
  exit 0
}

# SnowLuma 没就绪 / 账号不对：拒绝启动桥接，避免"看起来启动了其实发不出话"或"用错号说话"
if (-not $SkipSnowluma -and -not $snowlumaOk) {
  Write-Host ''
  if ($accountWrong) {
    Say '  没启动桥接：SnowLuma 登录的不是小鲸鱼的账号（详见上面的提示）。' 'Red'
    Say '  在控制台里换成小鲸鱼账号后，再双击一次这个图标就行。' 'Yellow'
  } else {
    Say '  没启动桥接：SnowLuma 网关没就绪。修好之后重新双击这个图标即可。' 'Red'
  }
  Read-Host '  按回车关闭'
  exit 1
}

# ── 4/4 启动桥接（守护循环） ────────────────────────────────────────
Say '  [4/4] 启动桥接（本窗口保持打开；退出后 5 秒自动重启）' 'Cyan'
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
