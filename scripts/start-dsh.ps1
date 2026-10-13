# 启动 DSH 并自动把 launch token 同步给 QQ 桥接。
#
# ⚠️ 为什么需要这个脚本（2026-10-13 事故）：
#   DSH 的 Web API 需要鉴权 —— 用 `dsh web` 启动时打印的那条
#       http://127.0.0.1:3080/?token=xxxx
#   里的 token 首次调用可以换一个 **30 天有效**的 cookie（见 qq-bridge/src/dsh-client.js）。
#   桥接把 cookie 存在 state\dsh-cookie.txt，过期后就必须重新用 token 换。
#   而 config.json 的 dsh.authToken 一直是空的 → cookie 一过期（本次是 10-10 到期），
#   桥接就开始 "DSH 不可用，消息入队"，主人在 QQ 里发的消息全部积压、她一个字也收不到。
#
#   本脚本把这条链路自动化：启动 DSH → 从它的输出里抓 token → 写进 config.json →
#   顺手把桥接拉起来。以后只要用这个脚本（或它生成的快捷方式）启动，就不会再哑。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dsh.ps1
#   powershell ... -File scripts\start-dsh.ps1 -SkipBridge      # 只起 DSH、只同步 token
param(
  [switch]$SkipBridge,
  [int]$DshWaitSeconds = 90
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot           # qq-bridge/
$CfgPath = Join-Path $Root 'config.json'
$OutLog = Join-Path $Root 'state\dsh-startup.log'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host "  $Text" -ForegroundColor $Color }

Write-Host ''
Say '🐋 启动 DSH 并同步 launch token' 'Cyan'
Say '────────────────────────────────────────────' 'DarkGray'

# ── 0. 已经有 DSH 在跑吗 ────────────────────────────────────────────────────
$portBusy = Test-NetConnection -ComputerName 127.0.0.1 -Port 3080 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($portBusy) {
  Say '注意：3080 上已有一个 DSH 实例在跑。' 'Yellow'
  Say '新启动的实例会因端口被占而失败，因此**拿不到新 token**。' 'Yellow'
  Say '要刷新 token，请先关掉那个 DSH 窗口，再运行本脚本。' 'Yellow'
  Say '（如果只是想让桥接重新连上，而 token 仍然有效，直接跑 scripts\restart-bridge.ps1 即可）' 'DarkGray'
  if (-not $SkipBridge) {
    Say '继续：只重启桥接…' 'DarkGray'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'restart-bridge.ps1')
  }
  exit 0
}

# ── 1. 启动 DSH（输出同时进文件，便于抓 token）──────────────────────────────
$logDir = Split-Path -Parent $OutLog
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (Test-Path $OutLog) { Remove-Item $OutLog -Force -ErrorAction SilentlyContinue }

$npx = 'C:\Program Files\nodejs\npx.cmd'
if (-not (Test-Path $npx)) { throw "找不到 npx.cmd：$npx" }

Say '启动 dsh web（新窗口，输出同时写入 state\dsh-startup.log）…' 'DarkGray'
$inner = "& '$npx' --verbose @deepseek-ai/dsh web 2>&1 | Tee-Object -FilePath '$OutLog'"
Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-NoExit', '-Command', $inner) | Out-Null

# ── 2. 从输出里抓 token ─────────────────────────────────────────────────────
Say '等待 launch token 出现…' 'DarkGray'
$deadline = (Get-Date).AddSeconds($DshWaitSeconds)
$token = ''
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (-not (Test-Path $OutLog)) { continue }
  try { $text = Get-Content $OutLog -Raw -Encoding UTF8 -ErrorAction Stop } catch { continue }
  $m = [regex]::Match($text, '[?&]token=([A-Za-z0-9_\-\.]{16,})')
  if ($m.Success) { $token = $m.Groups[1].Value; break }
}

if (-not $token) {
  Say "等待 $DshWaitSeconds 秒仍未抓到 token ✗" 'Red'
  Say '请打开那个新窗口看输出；若里面有一条带 ?token= 的 URL，把它整条复制给我即可。' 'Yellow'
  exit 1
}
Say ("已抓到 token：" + $token.Substring(0, [Math]::Min(12, $token.Length)) + '…') 'Green'

# ── 3. 写进 config.json ────────────────────────────────────────────────────
# 用 node 改 JSON，避免 PowerShell 5.1 的 ANSI 解码坑（本项目踩过）。
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$js = @"
const fs=require('fs');
const p=process.argv[1], t=process.argv[2];
const c=JSON.parse(fs.readFileSync(p,'utf8'));
c.dsh=c.dsh||{};
const before=c.dsh.authToken?'(已有)':'(空)';
c.dsh.authToken=t;
fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n','utf8');
console.log('  config.json dsh.authToken: '+before+' → (已写入 '+t.length+' 字符)');
"@
& $nodeExe -e $js $CfgPath $token

# ── 4. 顺手把桥接拉起来 ─────────────────────────────────────────────────────
if (-not $SkipBridge) {
  Say '重启桥接（让新 token 生效）…' 'DarkGray'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'restart-bridge.ps1')
}

Say '完成 ✓' 'Green'
