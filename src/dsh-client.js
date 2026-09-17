// Node 环境的 DSH Web API 客户端（面向 DSH >= 0.1.5 的 Typert Remote 协议）。
//
// 与 0.1.1-rc.2 时代的旧客户端（@deepseek-ai/dsh-host-apiproxy）相比，0.1.5 有三处不兼容：
//   1. /api 对非浏览器客户端也要求浏览器会话 cookie（回环地址不再自动放行）；
//   2. endpoint 命名从 `a.b` 变成 `<namespace>/<method>`，payload 固定为 `{ args: {...} }`；
//   3. 会话事件不再是全局 `events.mux`，改为每会话一条 `session/follow` 流，
//      复用同一条 `/api/remote.mux` WebSocket。
//
// 本文件对外暴露与旧客户端**相同的方法面**（`api.host.describe` / `api.sessions.prompt` /
// `api.events.mux` …），因此 bridge.js 的调用点基本无需改动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_PATH = '/api';
const MUX_PATH = '/api/remote.mux';

/** 事件跟随的发现轮询间隔。 */
const DISCOVERY_INTERVAL_MS = 5000;
/** 会话停止运行后，继续保留跟随多久（毫秒）。 */
const FOLLOW_IDLE_CLOSE_MS = 120000;
/** 同时跟随的会话上限，防止子代理等把跟随数撑爆。 */
const MAX_FOLLOWS = 32;
/** 等待一条 session/follow 变为“已就绪”的超时。 */
const FOLLOW_READY_TIMEOUT_MS = 10000;

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/** 从 URL / token / `token=xxx` 片段里取出 launch token。 */
function normalizeLaunchToken(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const fromQuery = /[?&]token=([^&\s]+)/u.exec(raw);
  if (fromQuery) return decodeURIComponent(fromQuery[1]);
  if (raw.startsWith('token=')) return decodeURIComponent(raw.slice('token='.length));
  return raw;
}

/** 读取 config.json 里的 dsh.authToken（缺失或损坏时返回空串）。 */
function readConfiguredToken() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    const parsed = JSON.parse(text);
    return normalizeLaunchToken(parsed?.dsh?.authToken);
  } catch {
    return '';
  }
}

/** 解析鉴权参数：显式入参 > 环境变量 > config.json。 */
function resolveAuthOptions(options) {
  const stateDir = options.stateDir ?? path.join(ROOT, 'state');
  return {
    token: normalizeLaunchToken(
      options.authToken ?? process.env.DSH_AUTH_TOKEN ?? readConfiguredToken(),
    ),
    cookieFile: options.cookieFile ?? path.join(stateDir, 'dsh-cookie.txt'),
  };
}

/**
 * 把一次成功调用包成旧客户端那种 envelope，供 `unwrap()` 消费。
 * @param value - 业务返回值。
 */
function okEnvelope(value) {
  return { type: 'server-response', rpcId: randomUUID(), result: { ok: true, value } };
}

/** 把一次失败包成错误 envelope。 */
function errorEnvelope(code, message, details = {}) {
  return {
    type: 'server-response',
    rpcId: randomUUID(),
    result: { ok: false, error: { code, message, details } },
  };
}

/**
 * `/api/remote.mux` 的 Node 端客户端：一条物理 WebSocket 上复用多条逻辑流。
 * 帧协议（纯 JSON 文本）：
 *   出：`{ type:'open', streamId, endpoint, payload }` / `{ type:'cancel', streamId }`
 *   入：`{ type:'item', streamId, value? }` / `{ type:'end', streamId }` /
 *       `{ type:'error', streamId, error:{ code, message, details } }`
 */
class RemoteMuxClient {
  /** @param client - 持有它的 NodeApiClient（复用鉴权与 baseUrl）。 */
  constructor(client) {
    this.client = client;
    this.socket = undefined;
    this.connecting = undefined;
    /** @type {Map<string, { push: (frame: object) => void }>} */
    this.pending = new Map();
  }

  /** 惰性建立物理连接（带 cookie 升级）。 */
  async ensureSocket() {
    const ready = this.socket;
    if (ready !== undefined && ready.readyState === 1 /* OPEN */) return ready;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = (async () => {
      const cookie = await this.client.ensureCookie();
      const url = new URL(MUX_PATH, this.client.root);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, { headers: { cookie } });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          try { socket.close(); } catch { /* 已经关了 */ }
          reject(new Error(`${MUX_PATH} 连接超时`));
        }, 15000);
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
        };
        const onOpen = () => { cleanup(); resolve(); };
        // Node 的 WebSocket error 事件不带原因；401/404 都会落到这里。
        const onError = () => {
          cleanup();
          reject(new Error(`${MUX_PATH} 握手失败（多为 cookie 失效或该端点不存在）`));
        };
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
      });
      socket.addEventListener('message', (event) => this.route(event.data));
      const lost = (reason) => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.failAll(new Error(reason));
      };
      socket.addEventListener('close', () => lost(`${MUX_PATH} 连接已关闭`));
      socket.addEventListener('error', () => lost(`${MUX_PATH} 连接出错`));
      this.socket = socket;
      return socket;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  /** 把一条下行帧派发给对应的逻辑流。 */
  route(data) {
    if (typeof data !== 'string') return;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    const entry = this.pending.get(frame?.streamId);
    if (entry === undefined) return;
    if (frame.type === 'item') entry.push({ kind: 'item', value: frame.value });
    else if (frame.type === 'end') entry.push({ kind: 'end' });
    else if (frame.type === 'error') entry.push({ kind: 'error', error: frame.error });
  }

  /** 物理连接断开时，让所有在途逻辑流立刻失败。 */
  failAll(error) {
    for (const entry of this.pending.values()) entry.push({ kind: 'failed', error });
  }

  /**
   * 在复用连接上打开一条逻辑流。
   * @param endpoint - Typert Remote stream endpoint，如 `session/follow`。
   * @param args - 具名参数对象（wire 上的 `payload.args`）。
   * @param signal - 取消信号。
   * @yields Host 侧产出的每一项。
   */
  async *stream(endpoint, args, signal) {
    const socket = await this.ensureSocket();
    const streamId = randomUUID();
    const inbox = [];
    let wake;
    let failed;
    const push = (frame) => {
      inbox.push(frame);
      wake?.();
      wake = undefined;
    };
    this.pending.set(streamId, { push });
    const onAbort = () => push({ kind: 'end' });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: args ?? {} } }));
    let open = true;
    try {
      while (true) {
        while (inbox.length > 0) {
          const frame = inbox.shift();
          if (frame.kind === 'item') { yield frame.value; continue; }
          if (frame.kind === 'error') {
            open = false;
            const error = new Error(`${endpoint} 流错误: ${frame.error?.code}: ${frame.error?.message}`);
            error.code = frame.error?.code;
            error.details = frame.error?.details;
            throw error;
          }
          if (frame.kind === 'failed') { open = false; failed = frame.error; throw frame.error; }
          open = false;
          return;
        }
        if (failed !== undefined) throw failed;
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.pending.delete(streamId);
      if (open && socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: 'cancel', streamId })); } catch { /* 连接已断，忽略 */ }
      }
    }
  }
}

/**
 * 会话事件中枢：把 0.1.5 的“每会话一条 session/follow”重新拼成旧客户端的
 * 全局 `events.mux` 语义，向所有订阅者广播 `{ type:'session/event', sessionId, event }`。
 *
 * 为保证不漏事件，`sessions.prompt()` 会先 `ensureFollow()` 再投递 prompt，
 * 这样 follow 一定处于“已拿到 opening 帧”的存活状态；opening 快照本身被丢弃，
 * 因此不会把历史回复重放给 QQ。
 */
class SessionEventHub {
  /** @param client - 持有它的 NodeApiClient。 */
  constructor(client) {
    this.client = client;
    this.subscribers = new Set();
    /** @type {Map<string, { controller: AbortController, ready: Promise<void>, lastEventAt: number, running: boolean }>} */
    this.follows = new Map();
    this.timer = undefined;
    this.polling = false;
  }

  /** 是否有订阅者（无订阅者时不做任何跟随）。 */
  get active() {
    return this.subscribers.size > 0;
  }

  /**
   * 订阅全局会话事件流。
   * @param signal - 取消信号。
   * @param onOpen - 立即回调，通知调用方可以开始投递 prompt。
   * @returns 旧信封形状的异步可迭代对象。
   */
  subscribe(signal, onOpen) {
    const queue = { items: [], wake: undefined, done: false };
    this.subscribers.add(queue);
    const cleanup = () => {
      if (queue.done) return;
      queue.done = true;
      this.subscribers.delete(queue);
      queue.wake?.();
      queue.wake = undefined;
      if (!this.active) this.stopDiscovery();
    };
    signal?.addEventListener('abort', cleanup, { once: true });
    if (signal?.aborted) cleanup();
    this.startDiscovery();
    onOpen?.();
    const hub = this;
    return (async function* iterate() {
      try {
        while (!queue.done) {
          while (queue.items.length > 0) yield queue.items.shift();
          if (queue.done) return;
          await new Promise((resolve) => { queue.wake = resolve; });
        }
      } finally {
        cleanup();
      }
    })();
  }

  /** 向所有订阅者广播一帧。 */
  broadcast(frame) {
    for (const queue of this.subscribers) {
      if (queue.done) continue;
      queue.items.push({ rpcId: randomUUID(), payload: frame });
      queue.wake?.();
      queue.wake = undefined;
    }
  }

  /** 登记一个我们关心的会话（fire-and-forget）。 */
  interest(sessionId) {
    if (!this.active) return;
    this.ensureFollow(sessionId).catch((error) => {
      console.error(`[dsh-client] 跟随会话 ${sessionId} 失败:`, error?.message ?? error);
    });
  }

  /**
   * 确保某个会话的 follow 流已经存活。
   * @param sessionId - 目标会话。
   * @returns opening 帧已收到（流已就绪）时 resolve。
   */
  async ensureFollow(sessionId) {
    if (!sessionId) return;
    const existing = this.follows.get(sessionId);
    if (existing !== undefined) {
      await existing.ready;
      return;
    }
    let markReady;
    let markFailed;
    const ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
    // 没有订阅者时没人消费事件，避免空转。
    if (!this.active) { markReady(); return; }
    const entry = { controller: new AbortController(), ready, markReady, markFailed, lastEventAt: Date.now(), running: true };
    this.follows.set(sessionId, entry);
    this.runFollow(sessionId, entry).catch(() => {});
    const timer = setTimeout(() => markFailed(new Error(`等待会话 ${sessionId} 事件流就绪超时`)), FOLLOW_READY_TIMEOUT_MS);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 实际消费一条 session/follow 流。 */
  async runFollow(sessionId, entry) {
    let settled = false;
    try {
      for await (const frame of this.client.clientStream(
        'session/follow',
        // maxMessages 只约束 opening 快照；快照本来就会被丢弃，取 1 条即可避免长会话拉全量历史。
        { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } },
        entry.controller.signal,
      )) {
        if (!settled) { settled = true; entry.markReady(); }
        if (frame?.type === 'event' && frame.event) {
          entry.lastEventAt = Date.now();
          this.broadcast({ type: 'session/event', sessionId, event: frame.event });
        }
      }
    } catch (error) {
      if (!entry.controller.signal.aborted) {
        console.error(`[dsh-client] 会话 ${sessionId} 事件流中断:`, error?.message ?? error);
      }
      if (!settled) { settled = true; entry.markFailed(error); }
    } finally {
      if (!settled) entry.markReady();
      if (this.follows.get(sessionId) === entry) this.follows.delete(sessionId);
    }
  }

  /** 开始发现轮询：把 externally 触发的会话也纳入跟随。 */
  startDiscovery() {
    if (this.timer !== undefined) return;
    const tick = async () => {
      this.timer = undefined;
      if (!this.active) return;
      await this.poll();
      if (!this.active) return;
      this.timer = setTimeout(tick, DISCOVERY_INTERVAL_MS);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, DISCOVERY_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 停止发现轮询。 */
  stopDiscovery() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** 一次发现：跟住 running 会话，并回收长期空闲的跟随。 */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    let items = [];
    try {
      const response = await this.client.call('session/list', { _request: {} });
      if (response?.result?.ok === true) items = response.result.value?.items ?? [];
    } catch {
      // DSH 暂时不可达：保持现有跟随，等下一轮。
      this.polling = false;
      return;
    }
    this.polling = false;
    const now = Date.now();
    const running = new Map();
    for (const item of items) {
      if (item?.sessionId) running.set(item.sessionId, item.running === true);
    }
    for (const [sessionId, isRunning] of running) {
      if (!isRunning) continue;
      if (this.follows.has(sessionId)) {
        this.follows.get(sessionId).running = true;
        continue;
      }
      if (this.follows.size >= MAX_FOLLOWS) break;
      this.interest(sessionId);
    }
    for (const [sessionId, entry] of this.follows) {
      const isRunning = running.get(sessionId) === true;
      entry.running = isRunning;
      if (!isRunning && now - entry.lastEventAt > FOLLOW_IDLE_CLOSE_MS) {
        entry.controller.abort();
      }
    }
  }
}

/**
 * DSH Web API 客户端（Node 端，0.1.5 Typert Remote 协议）。
 *
 * 鉴权：`dsh web` 启动时会打印一条带 `?token=` 的 URL，把这个 token 填到
 * `config.json` 的 `dsh.authToken`（整条 URL 也可以）即可。首次调用时客户端会用它
 * 换取 30 天有效的浏览器会话 cookie 并缓存到 `state/dsh-cookie.txt`，
 * 之后即使不带 token 也能继续用，直到 cookie 过期。
 */
export class NodeApiClient {
  /**
   * @param baseUrl - DSH Web API 根地址，默认 `http://127.0.0.1:3080`。
   * @param timeoutMs - 保留参数（旧签名兼容），当前未使用。
   * @param options - `{ authToken, cookieFile, stateDir }`。
   */
  constructor(baseUrl, timeoutMs, options) {
    this.root = stripTrailingSlash(baseUrl ?? 'http://127.0.0.1:3080');
    this.timeoutMs = timeoutMs;
    this.auth = resolveAuthOptions(options ?? {});
    this.cookie = undefined;
    this.cookiePromise = undefined;
    this.mux = new RemoteMuxClient(this);
    this.hub = new SessionEventHub(this);

    this.host = {
      // 0.1.5 没有 host.describe；用最轻的只读端点做连通性探活，404 时退回 settings。
      describe: async () => {
        try {
          return await this.call('llm/listProviders', {});
        } catch (error) {
          if (/HTTP 404/u.test(String(error?.message ?? ''))) {
            return this.call('settings/describe', {});
          }
          throw error;
        }
      },
    };

    this.settings = {
      describe: () => this.call('settings/describe', {}),
    };

    this.agentPresets = {
      list: () => this.call('agentPresets/list', {}),
    };

    this.workspace = {
      create: (request) => this.call('workspace/create', { request: request ?? {} }),
      rename: (request) => this.call('workspace/rename', { request: request ?? {} }),
      delete: (request) => this.call('workspace/delete', { request: request ?? {} }),
      archiveSession: (request) => this.call('workspace/archiveSession', { request: request ?? {} }),
      // 0.1.5 没有 workspace/list 一元端点，改为读取 workspace/follow 的 baseline 快照。
      list: async () => {
        try {
          const baseline = await this.workspaceBaseline();
          return okEnvelope({ items: baseline.items ?? [], archivedSessionIds: baseline.archivedSessionIds ?? [] });
        } catch (error) {
          return errorEnvelope('workspace/unavailable', String(error?.message ?? error));
        }
      },
    };

    this.sessions = {
      create: async (request) => {
        const response = await this.call('session/create', { request: request ?? {} });
        if (response?.result?.ok === true) {
          this.hub.interest(response.result.value?.sessionId);
        }
        return response;
      },
      prompt: async (request) => {
        // 先让事件流就绪再投递，避免 follow 建立前的回复事件被快照吞掉。
        await this.hub.ensureFollow(request?.sessionId).catch((error) => {
          console.error(`[dsh-client] 会话 ${request?.sessionId} 事件流未就绪:`, error?.message ?? error);
        });
        return this.call('session/prompt', {
          request: { requestId: randomUUID(), ...request },
        });
      },
      selectModel: (request) => this.call('session/selectModel', { request: request ?? {} }),
    };

    this.events = {
      mux: (_payload, signal, onOpen) => this.hub.subscribe(signal, onOpen),
    };
  }

  /**
   * 发一次一元 RPC。
   * @param endpoint - `<namespace>/<method>`。
   * @param args - 具名参数对象（wire 上的 `payload.args`）。
   * @returns 旧客户端形状的 server-response envelope。
   */
  async call(endpoint, args) {
    let cookie = await this.ensureCookie();
    let response = await this.post(endpoint, args, cookie);
    if (response.status === 401) {
      // cookie 过期或 DSH 换了签名密钥：清掉重换一次再试。
      this.cookie = undefined;
      cookie = await this.ensureCookie(true);
      response = await this.post(endpoint, args, cookie);
    }
    if (response.status === 404) {
      throw new Error(`transport failure for ${API_PATH}/${endpoint}: HTTP 404（该 DSH 版本没有这个端点）`);
    }
    if (!response.ok) {
      throw new Error(`transport failure for ${API_PATH}/${endpoint}: HTTP ${response.status}`);
    }
    return response.json();
  }

  /** 发一次裸 POST。 */
  async post(endpoint, args, cookie) {
    const rpcId = randomUUID();
    return fetch(`${this.root}${API_PATH}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args: args ?? {} },
      }),
    });
  }

  /** 取一条 workspace/follow 的 opening baseline。 */
  async workspaceBaseline() {
    const controller = new AbortController();
    try {
      for await (const frame of this.clientStream('workspace/follow', {}, controller.signal)) {
        if (frame?.type === 'baseline') return frame.value ?? {};
      }
      throw new Error('workspace/follow 在返回 baseline 前就结束了');
    } finally {
      controller.abort();
    }
  }

  /** 打开一条逻辑流（`/api/remote.mux`）。 */
  clientStream(endpoint, args, signal) {
    return this.mux.stream(endpoint, args, signal);
  }

  /**
   * 确保拿到可用的浏览器会话 cookie（内存 → 缓存文件 → token 兑换）。
   * @param force - 忽略内存缓存，强制重新解析。
   */
  async ensureCookie(force = false) {
    if (!force && this.cookie !== undefined) return this.cookie;
    if (!force) {
      const cached = readCookieFile(this.auth.cookieFile);
      if (cached) {
        this.cookie = cached;
        return cached;
      }
    }
    if (this.cookiePromise !== undefined) return this.cookiePromise;
    this.cookiePromise = this.exchangeToken().finally(() => { this.cookiePromise = undefined; });
    return this.cookiePromise;
  }

  /** 用 launch token 换 cookie，并落盘缓存。 */
  async exchangeToken() {
    if (!this.auth.token) {
      const cached = readCookieFile(this.auth.cookieFile);
      if (cached) {
        this.cookie = cached;
        return cached;
      }
      throw new Error(
        'DSH 需要浏览器会话鉴权，但没有可用的凭据：请把 `dsh web` 启动时打印的带 `?token=` 的 URL '
        + '（或其中 token 的值）填到 config.json 的 dsh.authToken，或设置环境变量 DSH_AUTH_TOKEN。',
      );
    }
    const response = await fetch(`${this.root}/?token=${encodeURIComponent(this.auth.token)}`, {
      redirect: 'manual',
    });
    if (response.status !== 303 && response.status !== 302 && response.status !== 200) {
      throw new Error(`DSH token 兑换失败：HTTP ${response.status}（token 是否已过期？重启 dsh web 会换新的 token）`);
    }
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    const cookie = raw.map((entry) => entry.split(';')[0]).filter(Boolean).join('; ');
    if (!cookie) {
      throw new Error('DSH token 兑换失败：响应里没有 Set-Cookie（token 可能已失效）');
    }
    this.cookie = cookie;
    try {
      fs.mkdirSync(path.dirname(this.auth.cookieFile), { recursive: true });
      fs.writeFileSync(this.auth.cookieFile, cookie, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.error('[dsh-client] cookie 缓存写入失败（不影响本次运行）:', error?.message ?? error);
    }
    return cookie;
  }
}

/** 读取 cookie 缓存文件。 */
function readCookieFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    }
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
