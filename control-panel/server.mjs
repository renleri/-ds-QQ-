// 小鲸鱼控制台 —— 本地聚合面板（零依赖，只用 Node 内置模块）
//
// 为什么单独做一个：状态散在四个地方（桥接控制台 3100、刷B站设置页、余额挂件、
// DSH 本身），想看全得点好几下。这个服务把它们聚合成一个页面，双击桌面图标就能看。
//
// 数据源（全部走本机回环，不对外）：
//   · 桥接     → http://127.0.0.1:3100/api/status?token=<state/console-token>
//   · 刷B站    → http://127.0.0.1:3080/api/bili-duty/status   （需要 DSH cookie）
//   · 余额     → http://127.0.0.1:3080/dsh-whale/balance.json （需要 DSH cookie）
//   · DSH      → 端口探活 + 进程
// DSH 的 cookie 直接复用桥接维护的那份（state/dsh-cookie.txt，30 天有效期），
// 这样控制台不需要自己维护一套凭据。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.QQ_CONSOLE_PORT) || 3110;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = process.env.QQ_BRIDGE_DIR || 'D:\\肥鱼的工作区\\qq-bridge';
const DSH_ORIGIN = process.env.DSH_ORIGIN || 'http://127.0.0.1:3080';
const PUBLIC_DIR = path.join(HERE, 'public');

const readText = (p, dflt = '') => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return dflt; } };
const readJson = (p, dflt = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } };

/** 带超时的 fetch，失败一律返回 null（某个数据源挂了不能拖垮整页）。 */
async function getJson(url, headers = {}, timeoutMs = 6000) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url, { headers, signal: ac.signal });
    clearTimeout(timer);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { status: r.status, json, text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}

/** DSH 的 cookie（桥接维护的那份）。 */
function dshCookie() {
  const raw = readText(path.join(BRIDGE_DIR, 'state', 'dsh-cookie.txt'));
  return raw && raw.includes('=') ? raw : '';
}

/** cookie 到期时间（只用于面板提示，解不出来就算了）。 */
function dshCookieExpiry() {
  try {
    const raw = readText(path.join(BRIDGE_DIR, 'state', 'dsh-cookie.txt'));
    const payload = JSON.parse(Buffer.from(raw.slice(raw.indexOf('=') + 1).split('.')[1], 'base64url').toString('utf8'));
    return { issuedAt: Number(payload?.issuedAt) || 0, expiresAt: Number(payload?.expiresAt) || 0 };
  } catch { return null; }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1200);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function bridgeLockPid() {
  const pid = Number(readText(path.join(BRIDGE_DIR, 'state', 'bridge.lock'), ''));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

/**
 * SnowLuma 网关状态。
 * 它一个进程同时监听 3000（OneBot HTTP）/3001（WS）/5099（WebUI）；
 * WebUI 的 /api/* 需要认证，所以这里走「端口反查进程 + 读安装目录 package.json」。
 * 进程探测要跑一次 PowerShell（约 0.5s），因此缓存 20 秒，避免每次刷新都卡。
 */
const SNOWLUMA_DIR = process.env.SNOWLUMA_DIR || path.join(process.env.USERPROFILE || '', 'Desktop', 'suno');
let slCache = { at: 0, value: null };

/** 跑一段 PowerShell 表达式，返回 stdout 文本（失败返回空串）。 */
function runPowerShellText(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function snowlumaStatus() {
  if (Date.now() - slCache.at < 20000 && slCache.value) return slCache.value;

  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(SNOWLUMA_DIR, 'package.json'), 'utf8')).version || '';
  } catch { }

  let pid = 0, memoryMB = 0, uptimeSec = 0;
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$c = Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1',
    'if ($c) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"',
    '  if ($p) {',
    '    $up = ((Get-Date) - [datetime]$p.CreationDate).TotalSeconds',
    '    "$($p.ProcessId)|$([int]($p.WorkingSetSize/1MB))|$([int]$up)"',
    '  }',
    '}',
  ].join('; ');
  const out = await runPowerShellText(ps);
  const m = /^(\d+)\|(\d+)\|(\d+)$/m.exec(String(out || '').trim());
  if (m) { pid = Number(m[1]); memoryMB = Number(m[2]); uptimeSec = Number(m[3]); }

  const value = {
    version,
    platform: `${process.platform}-${process.arch}`,
    pid, memoryMB, uptimeSec,
    on: pid > 0,
    dir: SNOWLUMA_DIR,
  };
  slCache = { at: Date.now(), value };
  return value;
}

/**
 * SnowLuma 今天的错误/警告摘要。
 * 日志动辄几 MB（今天 4.5MB、10-24 有 7MB），所以**只读文件尾部 512KB**，
 * 按行的 \bERROR\b / \bWARN\b 筛，取最后 8 条。DEBUG 行（MsgPush.UnknownElement 那种）
 * 占了 99%，全部丢掉 —— 否则一条有效信息都看不见。
 */
async function snowlumaLogs() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `snowluma-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.log`;
  const file = path.join(SNOWLUMA_DIR, 'logs', name);
  try {
    const stat = fs.statSync(file);
    const take = Math.min(stat.size, 512 * 1024);
    const buf = Buffer.alloc(take);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, take, stat.size - take); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.shift(); // 首行可能被截断
    const issues = [];
    let errCount = 0, warnCount = 0;
    for (const line of lines) {
      if (/\bERROR\b/.test(line)) { errCount++; issues.push(line); }
      else if (/\bWARN\b/.test(line)) { warnCount++; issues.push(line); }
    }
    return {
      ok: true,
      file: name,
      sizeMB: Math.round((stat.size / 1048576) * 10) / 10,
      errCount, warnCount,
      scanned: lines.length,
      recent: issues.slice(-8).map((l) => l.slice(0, 320)),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 120), file: name };
  }
}

async function collect() {
  const out = { at: new Date().toISOString(), bridge: {}, bili: {}, balance: {}, dsh: {}, auth: {} };

  // ── 桥接 ────────────────────────────────────────────────────────────
  const consoleToken = readText(path.join(BRIDGE_DIR, 'state', 'console-token'));
  const pid = bridgeLockPid();
  const [p3100, p3001, p3080] = await Promise.all([portOpen(3100), portOpen(3001), portOpen(3080)]);
  out.bridge.pid = pid;
  out.bridge.alive = !!pid;
  out.bridge.console = p3100;
  out.bridge.snowluma = p3001;
  if (consoleToken) {
    const r = await getJson(`http://127.0.0.1:3100/api/status?token=${encodeURIComponent(consoleToken)}`);
    if (r.json) {
      out.bridge.role = r.json.role ?? '';
      out.bridge.mode = r.json.roleMode ?? r.json.mode ?? '';
      out.bridge.maxMessageChars = r.json.maxMessageChars;
    }
  }
  // 模式来源（日志里最后一条「模式来源」）
  try {
    const log = fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'bridge.log'), 'utf8');
    const m = [...log.matchAll(/模式来源：(.+)/g)].pop();
    if (m) out.bridge.modeSource = m[1].trim().slice(0, 60);
    // 最近一条「DSH 不可用」
    const bad = [...log.matchAll(/^.*DSH 不可用.*$/gm)].pop();
    out.bridge.dshDownLine = bad ? bad[0].trim().slice(0, 80) : '';
  } catch { }

  // ── DSH 认证 ────────────────────────────────────────────────────────
  const cookie = dshCookie();
  out.auth.hasCookie = !!cookie;
  const exp = dshCookieExpiry();
  if (exp && exp.expiresAt) {
    out.auth.expiresAt = new Date(exp.expiresAt).toISOString();
    out.auth.daysLeft = Math.round(((exp.expiresAt - Date.now()) / 86400000) * 10) / 10;
  }

  // ── 刷B站 ───────────────────────────────────────────────────────────
  if (p3080 && cookie) {
    const r = await getJson(`${DSH_ORIGIN}/api/bili-duty/status`, { cookie });
    if (r.json?.ok) {
      const j = r.json;
      out.bili = {
        ok: true,
        version: j.version,
        loggedIn: !!j.loggedIn,
        venvReady: !!j.venvReady,
        installing: !!j.installing,
        installFailed: !!j.installFailed,
        asrReady: !!j.asrReady,
        cruise: j.config?.cruise ?? '',
        bait: !!j.config?.bait,
        perDay: j.config?.perDay,
        today: j.today,
        ranToday: j.ranToday,
        pickedToday: j.pickedToday,
        lastRunAt: j.lastRunAt,
        lastResult: j.lastResult,
        config: j.config ?? null,
        report: typeof j.report === 'string' ? j.report.slice(0, 4000) : '',
      };
    } else {
      out.bili = { ok: false, status: r.status, error: (r.json?.error || r.text || '').slice(0, 120) };
    }
  } else {
    out.bili = { ok: false, error: !p3080 ? 'DSH 未运行' : '没有 DSH cookie（跑过桥接才会生成）' };
  }

  // ── 余额 ────────────────────────────────────────────────────────────
  if (p3080 && cookie) {
    const r = await getJson(`${DSH_ORIGIN}/dsh-whale/balance.json`, { cookie });
    if (r.json?.ok) {
      out.balance = {
        ok: true,
        total: r.json.totalBalance,
        bonus: r.json.bonusBalance,
        recharge: r.json.rechargeBalance,
        currency: r.json.currency,
        source: r.json.balanceSource,
        updatedAt: r.json.updatedAt,
      };
    } else {
      out.balance = { ok: false, status: r.status };
    }
  }

  // ── DSH 本身 ────────────────────────────────────────────────────────
  out.dsh.running = p3080;

  // ── SnowLuma 网关 ───────────────────────────────────────────────────
  out.snowluma = await snowlumaStatus();
  out.snowluma.logs = await snowlumaLogs();

  // ── 按群活跃度（桥接的管理 API，用 console token）────────────────────
  try {
    const ct = readText(path.join(BRIDGE_DIR, 'state', 'console-token'));
    if (ct && p3100) {
      const r = await getJson(`http://127.0.0.1:3100/api/admin/groups?token=${encodeURIComponent(ct)}`);
      if (r.json?.ok) out.groups = { ok: true, list: r.json.groups, defaultProb: r.json.defaultProb };
      else out.groups = { ok: false, error: `桥接返回 ${r.status}` };
    } else {
      out.groups = { ok: false, error: !p3100 ? '桥接未运行' : '缺少控制台令牌' };
    }
  } catch (error) {
    out.groups = { ok: false, error: String(error?.message ?? error).slice(0, 100) };
  }

  return out;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 读请求体（限 256KB，防意外大包）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 262144) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

async function postJson(url, body, cookie, timeoutMs = 20000) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { status: r.status, json, text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}

/**
 * 刷B站：可写字段白名单（与插件 `/api/bili-duty/config` 接受的表一致）。
 * 只放行这些键，避免把任意内容塞进插件配置。
 */
const BILI_WRITABLE = new Set([
  'perDay', 'perRun', 'peakValley', 'cruise', 'bait', 'upList', 'noon', 'night',
  'autoComment', 'transcribe', 'asrModel', 'commentPerRound', 'mentionName',
  'dmMode', 'dmUid', 'keywords', 'mode', 'reportLevel', 'replyToComments', 'replyPerRound',
  // dshBin：跑一轮要靠它找到 dsh 可执行文件。npx 装的 dsh 没有全局命令，
  // 必须显式指向 …/@deepseek-ai/dsh/lib/bin.js，否则日志会写「没在常见位置找到 dsh」
  // 且退化成 cmd 调用（撞 8191 字符上限 → 命令行太长）。
  'dshBin',
]);

/** 允许的动作（白名单；不接受任意命令）。 */
const ACTIONS = {
  'restart-bridge': () => runPowerShell(path.join(BRIDGE_DIR, 'scripts', 'restart-bridge.ps1'), ['-WaitSeconds', '70']),
  'bili-run': async () => {
    const cookie = dshCookie();
    if (!cookie) return { ok: false, error: '没有 DSH cookie' };
    const r = await getJson(`${DSH_ORIGIN}/api/bili-duty/run`, { cookie, 'content-type': 'application/json' });
    return { ok: r.status === 200, status: r.status, detail: (r.json ?? r.text ?? '').toString().slice(0, 200) };
  },
  'bili-install': async () => {
    const cookie = dshCookie();
    if (!cookie) return { ok: false, error: '没有 DSH cookie' };
    const r = await getJson(`${DSH_ORIGIN}/api/bili-duty/install`, { cookie, 'content-type': 'application/json' });
    return { ok: r.status === 200, status: r.status, detail: (r.text ?? '').slice(0, 200) };
  },
};

function runPowerShell(script, args) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout: 180000, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, detail: String(stdout || stderr || err?.message || '').slice(-800) }));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/api/all') return sendJson(res, 200, await collect());
    // 刷B站配置：白名单过滤后转发给插件（它自己会做范围钳制 + 双写 config.json 与 DSH 设置页）
    if (req.method === 'POST' && url.pathname === '/api/bili-config') {
      const cookie = dshCookie();
      if (!cookie) return sendJson(res, 200, { ok: false, error: '没有 DSH cookie（先让桥接跑起来，它会维护这份凭据）' });
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      const patch = {};
      for (const [k, v] of Object.entries(body)) if (BILI_WRITABLE.has(k)) patch[k] = v;
      if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: '没有可写入的字段' });
      const r = await postJson(`${DSH_ORIGIN}/api/bili-duty/config`, patch, cookie);
      return sendJson(res, 200, {
        ok: r.status === 200 && r.json?.ok === true,
        status: r.status,
        sent: Object.keys(patch),
        config: r.json?.config,
        host: r.json?.host,
        detail: r.status === 200 ? '' : (r.json?.error ?? r.text ?? '').slice(0, 200),
      });
    }
    // 群活跃度：转发给桥接的 /api/admin/group-activity（桥接自己做校验与存盘）
    if (req.method === 'POST' && url.pathname === '/api/group-activity') {
      const ct = readText(path.join(BRIDGE_DIR, 'state', 'console-token'));
      if (!ct) return sendJson(res, 200, { ok: false, error: '缺少桥接控制台令牌' });
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      const r = await postJson(`http://127.0.0.1:3100/api/admin/group-activity?token=${encodeURIComponent(ct)}`, body, '');
      return sendJson(res, 200, {
        ok: r.status === 200 && r.json?.ok === true,
        status: r.status,
        detail: r.json?.error ?? (r.status === 200 ? '' : (r.text ?? '').slice(0, 160)),
        result: r.json,
      });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/action/')) {
      const name = url.pathname.slice('/api/action/'.length);
      const fn = ACTIONS[name];
      if (!fn) return sendJson(res, 404, { ok: false, error: '未知动作' });
      return sendJson(res, 200, await fn());
    }
    // 静态文件
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`小鲸鱼控制台已启动：http://127.0.0.1:${PORT}`);
  console.log(`  桥接目录: ${BRIDGE_DIR}`);
  console.log(`  DSH: ${DSH_ORIGIN}`);
});
