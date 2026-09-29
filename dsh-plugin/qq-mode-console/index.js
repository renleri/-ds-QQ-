// QQ 桥接模式控制台（Host-only bundle，适配 dsh 0.2.x）。
//
// ── 为什么重写（2026-09-29 实测 0.2.0-rc.1）────────────────────────────
// 旧版是为 0.1.x 写的，用了两样在 0.2.x 已经不存在的东西：
//
//   1) Host 半边：ctx.settings.register('qq-mode', schema, {...})
//      0.2.x 的 settings 服务只剩 configure / describe / update / replace / mutate，
//      **没有 register**。旧代码走到 `typeof settings.register !== 'function'`
//      就 diag 一行然后静默 return —— 表现就是"插件装在那儿但完全没生效"：
//      WebUI 里没有卡片，settings.describe 里也没有 qq-mode 命名空间，
//      桥接只能悄悄回退去读 state/mode.json。
//
//   2) Client 半边：把 React 卡片挂到槽位 "settings.plugins.tab"
//      0.2.x 的槽位树里没有这个名字（Settings 页已改为 Plugins 页的 plugins.* 系列）。
//      slots.inject 一直等一个永远不出现的槽位 —— 同样静默失效。
//
// 0.2.x 的官方做法简单得多：**插件导出 Config schema，设置界面自动生成**
// （settings 服务的 configure({ auto }) 默认就开着），不需要注册命名空间、
// 也不需要手写任何 UI。所以这个 bundle 现在是 Host-only，client.js 整个删掉。
//
// ── 命名空间的变化（关键）─────────────────────────────────────────────
// 自动生成的表单项按 **profile entry id** 索引，所以 settings.describe 里的 ns
// 从旧版的 'qq-mode' 变成了 'qq-mode-console'（= 本 patch 的 entry id）。
// qq-bridge 侧已同步兼容两者，见 src/bridge.js 的 refreshMode()。
import z from '@deepseek-ai/schemastery';

export const name = 'qq-mode-console';

/** 不依赖任何服务：本插件只需要一个 Config。 */
export const inject = [];

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

/**
 * 不需要注册服务或界面：Config 会被 DSH 自动投影成设置表单项，
 * 取值写进 profile patch（applies: live），桥接进程轮询 settings/describe 读取。
 */
export function apply() {}
