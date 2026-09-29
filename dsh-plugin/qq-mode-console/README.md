# qq-mode-console

在 **DSH WebUI 的设置里切换 QQ 桥接模式**（`chat` / `closed-agent` / `reserved` / `reserved2`）。

改完即时生效（`applies: live`）：取值写进 profile patch，`qq-bridge` 进程轮询
DSH 的 `settings/describe` 读取，不需要重启桥接。

## 为什么会有这个 0.2.x 重写版

旧版是给 dsh **0.1.x** 写的，用了两样在 0.2.x 已经不存在的东西 —— 结果就是
「插件装在那儿，但完全没生效」：

| 旧做法（0.1.x） | 0.2.x 的现实 |
|---|---|
| Host：`ctx.settings.register('qq-mode', schema, {...})` | `settings` 服务只剩 `configure` / `describe` / `update` / `replace` / `mutate`，**没有 `register`** → 旧代码 `typeof settings.register !== 'function'` 后静默 `return` |
| Client：手写 React 卡片挂到槽位 `settings.plugins.tab` | 槽位树里**没有这个名字**（Settings 页已改为 Plugins 页的 `plugins.*` 系列）→ `slots.inject` 一直等一个永不出现的槽位 |

0.2.x 的官方做法简单得多：**插件导出 `Config` schema，设置界面自动生成**。
所以这个 bundle 现在是 **Host-only**，`client.js` 整个删掉了。

### 但只导出 Config 还不够（实测踩到的第二个坑）

装上之后用 `plugin_manager list_plugins` 查，会发现插件**确实激活了**：

```
{"entryId":"include:qq-mode-console","moduleName":"qq-mode-console",
 "enabled":true,"fiberPhase":"active","patchId":"qq-mode-console"}
```

`Config.listConfigs` 也能看到完整 schema（字段、枚举、说明都对）——
可是 `settings.describe()` 的 `namespaces` 里**没有它**，桥接因此读不到值。

原因：`settings.describe()` 只列出**认领过设置页策略**的条目。所以 `apply` 里必须调用：

```js
export const inject = ['settings'];
export function apply(ctx, config) {
  ctx.settings.configure({ auto: true });   // ← 缺这一步，设置界面里就没有它
}
```

另外插件会把当前取值**落一份到 profile 目录的 `qq-mode.json`**（`syncModeFile`），
让桥接有一个不依赖 `describe()` 过滤行为的、格式自控的来源。

### 命名空间 id

设置条目的 `ns` = **profile entry id**（本 patch 的 id，即 `qq-mode-console`；
loader 树里它的 entryId 是 `include:qq-mode-console`，但 ns 用裸 id）。
更早的版本里插件自己 `register` 的名字是 `qq-mode`。
`qq-bridge` 侧**两个都认**（`src/bridge.js` 的 `refreshMode()`），且有三路来源：

1. `qq-mode.json`（插件落盘，最可靠）
2. DSH `settings.describe()`（ns = `qq-mode-console` 或 `qq-mode`）
3. 本地 `state/mode.json`（DSH 不可用时的回退）

桥接日志会写一行 `模式来源：…`，一眼看出当前用的是哪一路。

## 安装

用插件管理器安装本目录（不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

安装会：把包 link 进 profile、把 `qq-mode-console` 加进 `dsh.profile.bundles`。
**替换已安装的包需要重启 DSH** 才会加载新的 JS 模块（配置层是 live 的，代码层不是）。

## 生效与排查

```powershell
# 1) 配置层：组合后的 profile 里应当出现本 entry（不需要重启）
pnpm dsh --profile web --dump-config   # 搜 qq-mode-console

# 2) 运行时：settings.describe 的 namespaces 里应当出现 ns = qq-mode-console
#    （重启 DSH 之后）
```

桥接侧确认：

```powershell
# 桥接日志里能看到它跟随设置切换模式；设置读不到时会回退 state/mode.json
```

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` 指向 patch；`meta` 提供显示标题/描述 |
| `cordis.patch.yml` | 声明 entry（`id: qq-mode-console`）与默认 config |
| `index.js` | 导出 `Config`（mode / ownerQQ）；`apply()` 不需要做任何事 |
