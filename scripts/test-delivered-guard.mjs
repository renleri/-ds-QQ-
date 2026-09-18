#!/usr/bin/env node
// deliveredSeq 回归测试（2026-09-18「晚安被 mark_read 吃掉」事故的护栏）。
//
// 背景：桥接新增了 deliveredSeq（她真正看过的最高消息序号），用来区分
// 「没看过」和「看过但选择不回」。这个脚本在真实桥接上验证两条关键行为：
//
//   1) qq_wait_for_messages 遇到「比等待更早到、但她没看过」的未读时，
//      不再傻等 timeoutMs，而是立刻把这些消息交给她（unseenUnread=true）。
//   2) qq_mark_read 只清「她看过的」（seq <= deliveredSeq），
//      没看过的一律保留并给出 note，不再静默吃掉。
//
// 用法（需要在桥接停止时注入测试数据，所以分两步）：
//   node _tools/test-delivered-guard.mjs inject     # 停桥接后：写入测试会话 + 备份原状态
//   node _tools/test-delivered-guard.mjs check      # 起桥接后：跑断言
//   node _tools/test-delivered-guard.mjs restore    # 停桥接后：还原状态
//
// 测试用的是两个不存在的群号（group:999999001/999999002），只在 state 里，
// 不碰 allow 白名单，所以对真实 QQ 会话零影响；跑完 restore 还原。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 兼容两种布局：脚本放在 <项目根>/scripts（项目根就是 ROOT）；或放在工作区 _tools
// （项目在 ROOT/qq-bridge）。用 console-token 是否存在来判断。
const BRIDGE = fs.existsSync(path.join(ROOT, 'state', 'console-token')) ? ROOT : path.join(ROOT, 'qq-bridge');
const STATE = path.join(BRIDGE, 'state', 'social-v2.json');
const BAK = path.join(BRIDGE, 'state', 'social-v2.json.testbak');
const PORT = Number(process.env.QQ_BRIDGE_PORT || 3100);

const KEY_A = 'group:999999001'; // 场景 1：等待前就到的未读，她从没看过
const KEY_B = 'group:999999002'; // 场景 2：deliveredSeq 之后又到了一条新未读

const fakeMsg = (seq, text) => ({
  seq,
  messageId: `test-${seq}`,
  sender: '测试用群友',
  userId: '10000',
  text,
  plain: text,
  tail: text,
  quoteTargetIsSelf: false,
  isOwner: false,
  isSelf: false,
  media: [],
  hasMedia: false,
  forwardIds: [],
  hasForward: false,
  time: Date.now(),
});

function readState() {
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}
function writeState(obj) {
  fs.writeFileSync(STATE, JSON.stringify(obj, null, 2), 'utf8');
}
function token() {
  return fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim();
}

async function api(pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}?token=${encodeURIComponent(token())}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const cmd = process.argv[2];

if (cmd === 'inject') {
  if (!fs.existsSync(BAK)) fs.copyFileSync(STATE, BAK);
  const st = readState();
  const base = {
    wakeConfig: { mode: 'diving', infinite: true, sleepUntil: null, triggers: { atMention: true, nameMention: true, speakerIds: [], keywords: [], question: true, poke: true, anyMessage: false, probability: 0 }, batchWindowMs: 8000, lastWakeAt: 0, wakeCount: 0, noActionCount: 0 },
    recentMessages: [],
    unread: [],
    lastWakeReason: '',
    lastAiReplyAt: 0,
    lastActionAt: 0,
    agentToken: '0'.repeat(31) + '1',
    bootstrapSent: true,
    wakeTimes: [],
    sendTimes: [],
    stickerCollectTimes: [],
    // 设成 10 分钟前：让 preSleepWaitBlockedV2 放行，否则 mark_read 会被
    // 「还没完成沉睡前观察」挡掉（那是另一个守卫，不是本测试要验的东西）。
    lastIncomingAt: Date.now() - 10 * 60 * 1000,
    preSleepWaitSatisfiedAt: 0,
    preSleepWaitObservedAt: 0,
    preSleepWaitAccumMs: 0,
    lastUnreadSeq: 0,
    deliveredSeq: 0,
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {},
  };
  // A：未读 99001，deliveredSeq=0 —— 她从没看过，等待工具应当立刻返回它
  st.conversations[KEY_A] = { ...base, agentToken: 'a'.repeat(32), recentMessages: [fakeMsg(99001, '测试消息A：等待前就到的未读')], unread: [fakeMsg(99001, '测试消息A：等待前就到的未读')], lastUnreadSeq: 99001, deliveredSeq: 0 };
  // B：deliveredSeq=99001（看过 99001），未读 99002 —— mark_read 必须保留 99002
  st.conversations[KEY_B] = { ...base, agentToken: 'b'.repeat(32), recentMessages: [fakeMsg(99001, '测试消息B-1：已看过'), fakeMsg(99002, '测试消息B-2：没看过')], unread: [fakeMsg(99002, '测试消息B-2：没看过')], lastUnreadSeq: 99002, deliveredSeq: 99001 };
  writeState(st);
  console.log(`已注入测试会话（原状态备份在 ${path.basename(BAK)}）`);
  process.exit(0);
}

if (cmd === 'restore') {
  if (!fs.existsSync(BAK)) { console.log('没有备份，跳过还原'); process.exit(0); }
  fs.copyFileSync(BAK, STATE);
  fs.unlinkSync(BAK);
  console.log('已还原 social-v2.json');
  process.exit(0);
}

if (cmd === 'check') {
  let pass = 0, fail = 0;
  const assert = (label, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
    else { fail++; console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
  };

  console.log('场景 1：等待前就到的未读，她没看过 → wait 应当立刻返回，不傻等');
  {
    const t0 = Date.now();
    const r = await api('/api/socialV2/wait', { method: 'POST', body: JSON.stringify({ key: KEY_A, timeoutMs: 60000 }) });
    const ms = Date.now() - t0;
    assert('HTTP 200', r.status === 200, `status=${r.status}`);
    assert('unseenUnread 标记为 true', r.json?.unseenUnread === true);
    assert('立刻返回（< 3 秒）而不是等 60 秒', ms < 3000, `实际 ${ms}ms`);
    assert('把那条没看过的消息交给了她', (r.json?.newMessages || []).some((m) => Number(m.seq) === 99001), `条数=${r.json?.newMessages?.length}`);
    assert('带上了说明用的 note', Boolean(r.json?.note));
  }

  console.log('场景 1b：看过之后再 mark_read → 应当正常清空');
  {
    const r = await api('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key: KEY_A }) });
    assert('markedCount = 1', r.json?.markedCount === 1, `markedCount=${r.json?.markedCount}`);
    assert('keptCount = 0', r.json?.keptCount === 0, `keptCount=${r.json?.keptCount}`);
  }

  console.log('场景 2：mark_read 遇到「没看过」的未读 → 必须保留');
  {
    const r = await api('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key: KEY_B }) });
    assert('markedCount = 0（99002 没看过，不该被清）', r.json?.markedCount === 0, `markedCount=${r.json?.markedCount}`);
    assert('keptCount = 1（保留未读）', r.json?.keptCount === 1, `keptCount=${r.json?.keptCount}`);
    assert('返回了提醒 note', Boolean(r.json?.note));
  }

  console.log('场景 2b：保留之后 wait → 也应当立刻把 99002 交出来');
  {
    const t0 = Date.now();
    const r = await api('/api/socialV2/wait', { method: 'POST', body: JSON.stringify({ key: KEY_B, timeoutMs: 60000 }) });
    const ms = Date.now() - t0;
    assert('unseenUnread = true', r.json?.unseenUnread === true);
    assert('立刻返回', ms < 3000, `实际 ${ms}ms`);
    assert('交出 99002', (r.json?.newMessages || []).some((m) => Number(m.seq) === 99002));
  }

  console.log('场景 2c：这次看过之后 mark_read → 应当清空');
  {
    const r = await api('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key: KEY_B }) });
    assert('markedCount = 1', r.json?.markedCount === 1, `markedCount=${r.json?.markedCount}`);
    assert('keptCount = 0', r.json?.keptCount === 0, `keptCount=${r.json?.keptCount}`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

console.log('用法: node _tools/test-delivered-guard.mjs inject|check|restore');
process.exit(2);
