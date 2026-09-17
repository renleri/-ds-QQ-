// DSH 兼容面自检：把 bridge.js 实际用到的每一个 DSH 端点打一遍。
//
// 关键判据：任何 `gateway/*` 错误码都说明**wire 形状写错了**（参数名/层级不对），
// 属于协议适配缺陷，必须失败；业务性错误码（session/*、workspace/* 等）是合法响应，
// 只记录不判负。
//
// 用法：node scripts/test-dsh-compat.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:3080';
const TIMEOUT_MS = 90000;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

/** 业务失败可以接受，协议形状失败不行。 */
function shapeGuard(label, response) {
  const result = response?.result;
  if (result?.ok === false && String(result.error?.code ?? '').startsWith('gateway/')) {
    throw new Error(`${label} wire 形状错误 → ${result.error.code}: ${result.error.message}`);
  }
  return response;
}

/** 读某个会话当前实际使用的模型，用于做无副作用的 selectModel 形状验证。 */
async function currentModelOf(api, sessionId) {
  const response = await api.call('session/list', { _request: {} });
  const items = response?.result?.value?.items ?? [];
  const item = items.find((entry) => entry.sessionId === sessionId);
  const selection = item?.projections?.values?.modelSelection;
  const chosen = selection?.lastUsed ?? selection?.next;
  if (!chosen?.provider || !chosen?.model) return undefined;
  return {
    provider: chosen.provider,
    model: chosen.model,
    ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
  };
}

async function main() {
  const api = new NodeApiClient(BASE);
  const workDir = path.join(ROOT, 'state', 'dsh-compat-test');
  fs.mkdirSync(workDir, { recursive: true });

  let workspaceId;
  let sessionId;
  let archived = false;
  let deleted = false;

  const deadline = setTimeout(() => {
    console.error(`❌ 兼容面自检超时（${TIMEOUT_MS}ms）`);
    process.exit(1);
  }, TIMEOUT_MS);
  deadline.unref?.();

  try {
    // 1. 连通性探活（bridge.js 的 checkDsh）
    try {
      const desc = unwrap(shapeGuard('host.describe', await api.host.describe({})), 'host.describe');
      record('host.describe（探活）', true, JSON.stringify(desc).slice(0, 80));
    } catch (error) {
      record('host.describe（探活）', false, error.message);
    }

    // 2. 设置
    try {
      const settings = unwrap(shapeGuard('settings.describe', await api.settings.describe({})), 'settings.describe');
      record('settings.describe', Array.isArray(settings?.namespaces), `namespaces=${settings?.namespaces?.length ?? 0}`);
    } catch (error) {
      record('settings.describe', false, error.message);
    }

    // 3. agent preset 名单
    let defaultPreset;
    try {
      const roster = unwrap(shapeGuard('agentPresets.list', await api.agentPresets.list({})), 'agentPresets.list');
      const presets = roster?.presets ?? [];
      defaultPreset = presets.find((p) => p.isDefault)?.id ?? presets[0]?.id;
      record('agentPresets.list', Array.isArray(presets) && presets.length > 0, `presets=${presets.length} default=${defaultPreset ?? '-'}`);
    } catch (error) {
      record('agentPresets.list', false, error.message);
    }

    // 4. 工作区：create / rename / list
    try {
      const created = unwrap(shapeGuard('workspace.create', await api.workspace.create({ path: workDir })), 'workspace.create');
      workspaceId = created?.workspace?.workspaceId;
      record('workspace.create', typeof workspaceId === 'string' && workspaceId.length > 0,
        `workspaceId=${workspaceId ?? '-'} created=${created?.created}`);
      if (workspaceId) {
        const renamed = await api.workspace.rename({ workspaceId, title: 'QQ 桥接兼容自检' });
        shapeGuard('workspace.rename', renamed);
        record('workspace.rename', renamed?.result?.ok !== false, renamed?.result?.ok === false ? renamed.result.error.code : 'ok');
      }
    } catch (error) {
      record('workspace.create', false, error.message);
    }

    try {
      const listed = unwrap(shapeGuard('workspace.list', await api.workspace.list({})), 'workspace.list');
      const items = listed?.items ?? [];
      const mine = workspaceId ? items.find((w) => w.workspaceId === workspaceId) : undefined;
      record('workspace.list（走 workspace/follow baseline）', Array.isArray(items) && mine !== undefined,
        `items=${items.length} found=${mine !== undefined} sessionIds=${mine?.sessionIds?.length ?? '-'}`);
    } catch (error) {
      record('workspace.list（走 workspace/follow baseline）', false, error.message);
    }

    // 5. 事件流：先订阅，再建会话、投递
    const collector = createTurnCollector();
    let globalFrames = 0;
    let opened = false;
    let resolveTurn;
    const turnDone = new Promise((resolve) => { resolveTurn = resolve; });
    const streamAbort = new AbortController();

    const pump = (async () => {
      for await (const envelope of api.events.mux({}, streamAbort.signal, () => { opened = true; })) {
        const frame = envelope.payload;
        if (frame.type === 'session/event') {
          globalFrames += 1;
          if (frame.sessionId === sessionId) {
            const ended = collector.push(frame.event);
            if (ended) resolveTurn(ended);
          }
        }
      }
    })().catch((error) => { record('events.mux 全局流', false, error.message); });

    await new Promise((resolve) => setTimeout(resolve, 200));
    record('events.mux 订阅建立', opened === true);

    // 6. 建会话
    try {
      const params = workspaceId ? { workspaceId } : { cwd: workDir };
      if (defaultPreset) params.agentPreset = defaultPreset;
      const created = unwrap(shapeGuard('sessions.create', await api.sessions.create(params)), 'sessions.create');
      sessionId = created?.sessionId;
      record('sessions.create', typeof sessionId === 'string' && sessionId.length > 0, `sessionId=${sessionId ?? '-'}`);
    } catch (error) {
      record('sessions.create', false, error.message);
    }

    if (sessionId) {
      // 7. 投递 prompt + 收 turn
      try {
        const accepted = await api.sessions.prompt({
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: '只回复两个字：收到' }],
        });
        shapeGuard('sessions.prompt', accepted);
        record('sessions.prompt', accepted?.result?.ok === true, JSON.stringify(accepted?.result?.value ?? accepted?.result?.error));
      } catch (error) {
        record('sessions.prompt', false, error.message);
      }

      const ended = await Promise.race([
        turnDone,
        new Promise((resolve) => setTimeout(() => resolve(null), 60000)),
      ]);
      record('turn 事件经 events.mux 抵达', ended !== null && ended?.text?.trim() === '收到',
        ended === null ? '超时' : `reason=${ended.reason?.kind} text=${JSON.stringify(ended.text?.trim())}`);
      record('全局流累计 session/event 帧', globalFrames > 0, `frames=${globalFrames}`);

      // 8. selectModel：只验证 wire 形状。
      //    ⚠️ DSH 0.1.5 的 session/selectModel 会**同时把选择写进全局默认模型设置**
      //    （settings 的 agent-default-model），因此这里必须用会话**当前**的模型做一次
      //    无副作用的重选；绝不能传探测用的假模型，否则会污染后续所有新会话。
      try {
        const current = await currentModelOf(api, sessionId);
        if (current === undefined) {
          record('sessions.selectModel（形状）', true, '跳过：读不到会话当前模型');
        } else {
          const selected = await api.sessions.selectModel({ sessionId, ...current });
          shapeGuard('sessions.selectModel', selected);
          record('sessions.selectModel（形状）', true,
            `${current.provider}/${current.model} → ${selected?.result?.ok === false ? `业务拒绝(${selected.result.error.code})` : 'ok'}`);
        }
      } catch (error) {
        record('sessions.selectModel（形状）', false, error.message);
      }
    }

    streamAbort.abort();
    await pump.catch(() => {});

    // 9. 清理
    if (sessionId) {
      const archivedResponse = await api.workspace.archiveSession({ sessionId }).catch((error) => ({ error }));
      archived = archivedResponse?.result?.ok === true;
      if (archivedResponse?.error) record('workspace.archiveSession', false, String(archivedResponse.error.message));
      else record('workspace.archiveSession', archived, archivedResponse?.result?.error?.code ?? 'ok');
    }
    if (workspaceId) {
      const deletedResponse = await api.workspace.delete({ workspaceId }).catch((error) => ({ error }));
      deleted = deletedResponse?.result?.ok === true;
      if (deletedResponse?.error) record('workspace.delete', false, String(deletedResponse.error.message));
      else record('workspace.delete', deleted, deletedResponse?.result?.error?.code ?? 'ok');
    }
  } finally {
    clearTimeout(deadline);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(`🎉 DSH 兼容面全部通过（${results.length} 项）`);
    process.exit(0);
  }
  console.log(`❌ DSH 兼容面失败 ${failed.length}/${results.length} 项：${failed.map((f) => f.name).join('、')}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('❌ 兼容面自检异常:', error?.message ?? error);
  process.exit(1);
});
