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

### 命名空间 id 变了（升级时最容易踩的地方）

自动生成的表单项按 **profile entry id** 索引，所以 `settings.describe` 里的 `ns`：

- 0.1.x：`qq-mode`（插件自己 `register` 的名字）
- 0.2.x：**`qq-mode-console`**（= 本 patch 的 entry id）

`qq-bridge` 侧（`src/bridge.js` 的 `refreshMode()`）**两个都认**，所以插件升级
不需要同步改桥接配置。

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
