# qq-chat-presets

把 QQ 聊天用的两个 **agent preset**（`qq-chat` / `qq-chat-v2`）注册进当前 DSH profile。

桥接按 `agentPreset: qq-chat-v2` 建会话；preset 不存在时 DSH 会**直接拒绝整个会话**：

```
gateway/internal: resume failed for session "session-…":
RemoteError: Unknown agent preset: qq-chat-v2
```

后果是她在 QQ 上完全收不到消息（每次唤醒投递都被拒），而不是"表现怪一点"。

## 为什么要单独做一个 bundle

预设原本放在 `~/.dsh/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`），
但**当前 DSH 已经不再扫描这个目录**（在安装包里搜不到 `.agent-presets`，
`agentPresets/list` 只返回 standard / ptc / minimal / cordis 四个内置预设）。

官方注册方式（见 checkout 的 `apps/web/tests/scaffold.ts`）是在 profile 里 insert 一个
`@deepseek-ai/dsh-agent-preset` entry，它的 `config.plugins` 就是一份 Loader entry 列表 ——
**正好等于 `agent.cordis.yml` 的内容**。所以这个 bundle 只做格式转换，不改预设内容。

## 生成

`cordis.patch.yml` 是**生成物**，不要手改：

```powershell
node scripts/build-preset-bundle.mjs          # 从 ~/.dsh/.agent-presets/ 读取并生成
```

生成时会把 `name: ./xxx.mjs` 这类**相对预设目录**的路径换成 `file://` URL ——
patch 里的相对路径不再以预设目录为基准，照抄会解析不到（`qq-tool-restrict.mjs` 就是这种情况）。

换机器时：把 `~/.dsh/.agent-presets/<id>/` 拷过去，重跑生成脚本，再重新安装一次。

## 安装

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

装完 `agentPresets/list` 里应出现 `qq-chat`（order 10）与 `qq-chat-v2`（order 11）。

### 两个实测踩到的坑

1. **profile 配置是 live 的，不用重启**。
   `install_bundle` 会对"替换已安装包"返回 `restart-required`，但**新增**一个 bundle
   是走 HMR 立即生效的 —— 实测：写完 profile 约 10 秒后 `agentPresets/list` 就有了。

2. **npx 版 dsh 装不了 bundle**：它的进程 PATH 里没有 `pnpm`，
   `install_bundle` 直接报 `'pnpm' 不是内部或外部命令`。
   跑源码 checkout 版（`corepack pnpm dsh web`）没这个问题。
   要让 npx 版也能装，需要 `corepack enable pnpm`（要写 Program Files，需管理员）。

## 姊妹问题：MCP 工具也一起消失过

修 preset 的同时发现她的 `mcp__snowluma__*` 工具全部 `unknown tool`。
原因在 **profile 的 `cordis.patch.yml`**：那三条 MCP 写成了 **id-targeted 覆盖**
（`- id: mcp-snowluma … disabled: true`），但 profile 里**根本没有这些 entry**，
所以只得到一条警告、插件从未加载：

```
patch: entry "mcp-snowluma" not found
```

正确写法是 **insert**：

```yaml
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: snowluma, transport: stdio, command: '…node.exe', args: ['…mcp-snowluma-safe.js'] }
```

> 一句话规律：**`- id:` 只能改已存在的 entry；要凭空加一个，必须用 `- insert:`。**
