// QQ 桥接模式控制台（Host-only bundle，兼容 dsh 0.1.7-rc.2 与 0.2.0-rc.1）。
//
// ── 为什么重写（2026-09-29 实测）──────────────────────────────────────
// 旧版是给更早的 dsh 写的，用了两样已经不存在的东西，撞上后**不报错、静默失效**：
//
//   1) Host 半边：ctx.settings.register('qq-mode', schema, {...})
//      0.1.7-rc.2 与 0.2.0-rc.1 的 settings 服务都只剩
//      configure / describe / update / replace / mutate —— **没有 register**。
//      旧代码走到 `typeof settings.register !== 'function'` 就 diag 一行然后 return，
//      表现是"插件装在那儿但完全没生效"。
//
//   2) Client 半边：把 React 卡片挂到槽位 "settings.plugins.tab"
//      0.2.x 的槽位树里没有这个名字（Settings 页改成了 Plugins 页的 plugins.* 系列），
//      slots.inject 一直等一个永远不出现的槽位 —— 同样静默失效。
//
// 新做法：插件导出 Config schema，由 DSH 自动生成设置界面，**不需要手写任何 UI**
// （所以这个 bundle 是 Host-only，client.js 整个删掉）。但有两个实测出来的关键点：
//
//   · 只导出 Config 还不够，必须在 apply 里调用 `ctx.settings.configure({ auto: true })`
//     认领本实例的设置页策略 —— 否则插件 fiberPhase=active、Config.listConfigs 也能看到
//     schema，但 settings.describe() 的 namespaces 里没有它，桥接读不到值。
//   · 取值同时落一份到 profile 目录的 qq-mode.json（见 syncModeFile），
//     这样桥接不必依赖 describe 的过滤行为，也有稳定、格式自控的来源。
//
// ── 命名空间 ─────────────────────────────────────────────────────────
// 设置条目的 ns = **profile entry id**（本 patch 的 id 即 `qq-mode-console`）。
// 更早的版本里插件自己 register 的名字是 `qq-mode`；qq-bridge 侧两个都认
// （见 src/bridge.js 的 refreshMode()），所以插件升级不必同步改桥接配置。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'qq-mode-console';

/** 需要 settings 服务：apply 里用它认领本实例的设置页策略（0.1.7/0.2.x 都有这个服务）。 */
export const inject = ['settings'];

/** 桥接模式取值；与 qq-bridge/src/bridge.js 的 VALID_MODES 保持一致。 */
export const MODES = ['chat', 'closed-agent', 'reserved', 'reserved2'];

export const Config = z.object({
  mode: z
    .union(MODES.map((mode) => z.const(mode)))
    .default('reserved2')
    .description(
      '桥接模式：chat 全量转发 / closed-agent 仅管理员私聊 / reserved 一代仿真 / reserved2 二代仿真',
    ),
  ownerQQ: z
    .string()
    .default('')
    .description('管理员 QQ；留空则沿用 qq-bridge/config.json 里的 ownerQQ'),
});

/** 落盘文件：profile 目录下的 qq-mode.json（包目录 = <profile>/node_modules/qq-mode-console）。 */
function resolveModeFile() {
  const override = String(process.env.QQ_MODE_FILE ?? '').trim();
  if (override) return override;
  try {
    const pkgDir = path.dirname(fileURLToPath(import.meta.url));
    return path.join(pkgDir, '..', '..', 'qq-mode.json');
  } catch {
    return '';
  }
}

/**
 * 把当前取值同步一份到 profile 目录下的 qq-mode.json。
 *
 * 为什么不只依赖 settings API：`settings.describe()` 只列出「已认领设置页策略」的条目，
 * 桥接进程靠 describe 读值时可能读不到本插件（实测：插件 fiberPhase=active、
 * Config.listConfigs 能看到 schema，但 describe 的 namespaces 里没有它）。
 * 多写这一份 JSON，桥接就有了稳定、格式自控的取值来源；**DSH 仍是唯一编辑入口**。
 */
function syncModeFile(config) {
  const file = resolveModeFile();
  if (!file) return;
  try {
    const payload = {
      mode: String(config?.mode ?? ''),
      ownerQQ: String(config?.ownerQQ ?? ''),
      updatedAt: new Date().toISOString(),
      source: 'qq-mode-console',
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // 写不进去也不能让插件激活失败：桥接还有 settings API 与 state/mode.json 两条路径。
  }
}

/**
 * 认领设置页策略（让 Config 真的出现在设置界面），并把取值同步到 qq-mode.json。
 *
 * 只导出 Config 而不调用 `settings.configure()` 的话，插件会激活成功但设置界面里没有它。
 */
export function apply(ctx, config = {}) {
  syncModeFile(config);
  const settings = ctx?.settings;
  if (!settings || typeof settings.configure !== 'function') return;
  try {
    const dispose = settings.configure({ auto: true });
    if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
      ctx.effect(() => dispose);
    }
  } catch {
    // 重复激活时已经认领过，不必报错。
  }
}
