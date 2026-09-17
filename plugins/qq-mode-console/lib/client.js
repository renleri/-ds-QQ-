// qq-mode-console 的浏览器半边（DSH 客户端插件 bundle）。
//
// 为什么需要这个文件：DSH 的「设置 → 插件 → 可配置插件」页只渲染
// 「Host 提供的 settings 命名空间」∩「注册进 settings.plugin.item 槽位的卡片」。
// 只注册命名空间而不注册卡片的 Host 插件不会渲染出任何东西
// （见 dsh-client-ui-settings-plugins 里 ConfigurablePluginsTabController 的说明：
//  “A served namespace no card claims renders nothing”）。
// 因此本包必须在客户端注册一张 key = 'qq-mode' 的卡片，卡片才会出现在设置页。
//
// 本文件是**已构建的 bundle**，格式由客户端模块系统规定：
//   window.__ModuleLoader__.load({ id, factory })
// factory 是 CJS 风格，require 只解析“平台基座表 / 已组合的动态包 row”里的模块。
// `react` 在平台基座表内（四十多个官方 bundle 都直接 require 它）。
window.__ModuleLoader__.load({
  id: "qq-mode-console",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    /** 与 Host 半边 lib/index.js 里的 QQMODE_NAMESPACE 保持一致。 */
    const NAMESPACE = "qq-mode";

    /** 与 Host 半边 QqModeSchema 的取值集合保持一致。 */
    const MODES = [
      ["chat", "chat — 全量转发（普通聊天模式）"],
      ["closed-agent", "closed-agent — 仅管理员私聊可用"],
      ["reserved", "reserved — 一代仿真（按空格分条）"],
      ["reserved2", "reserved2 — 二代仿真（AI 用工具自主收发）"]
    ];

    const FALLBACK_MODE = "reserved2";

    /** 硬依赖：槽位注册表 + 设置命名空间作用域。 */
    const inject = ["slots", "settingsScope"];

    /**
     * 挂载 qq-mode 设置卡片。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const settingsScope = ctx.get("settingsScope");
      if (settingsScope === undefined) {
        console.error("[qq-mode-console] settingsScope 服务不可用，无法挂载设置卡片");
        return;
      }
      const slots = ctx.get("slots");
      if (slots === undefined) {
        console.error("[qq-mode-console] slots 服务不可用，无法挂载设置卡片");
        return;
      }

      const scope = settingsScope.bind({ namespace: NAMESPACE });

      // useSyncExternalStore 要求 subscribe/getSnapshot 是稳定引用，因此在 apply 里建一次。
      const subscribe = (onChange) => scope.subscribe(onChange);
      const getSnapshot = () => scope.getSnapshot();

      function QqModeCard() {
        const snapshot = react.useSyncExternalStore(subscribe, getSnapshot);
        const section = snapshot.value ?? {};
        const current = typeof section.mode === "string" ? section.mode : FALLBACK_MODE;
        const writable = snapshot.writable !== false;
        const loading = snapshot.status === "loading";

        const onSelect = (event) => {
          const next = event.target.value;
          // settingsScope.set 会带最新 revision 落到 Host 的 settings/mutate；
          // 失败时 Host 的错误会从这里冒出来，保留在控制台便于排查。
          Promise.resolve(scope.set("mode", next)).catch((error) => {
            console.error("[qq-mode-console] 写入 qq-mode 失败:", error);
          });
        };

        const children = [
          react.createElement(
            "div",
            { key: "title", style: { fontWeight: 600, marginBottom: "2px" } },
            "QQ 桥接模式"
          ),
          react.createElement(
            "label",
            {
              key: "row",
              htmlFor: "qq-mode-select",
              style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }
            },
            "模式",
            react.createElement(
              "select",
              {
                id: "qq-mode-select",
                value: current,
                disabled: loading || !writable,
                onChange: onSelect,
                style: { minWidth: "22em", padding: "2px 4px" }
              },
              MODES.map(([id, text]) =>
                react.createElement("option", { key: id, value: id }, text)
              )
            )
          ),
          react.createElement(
            "div",
            { key: "hint", style: { opacity: 0.65, fontSize: "12px", lineHeight: 1.5 } },
            loading
              ? "正在读取 Host 设置…"
              : `当前：${current}　revision ${snapshot.revision ?? "-"}　`
                + "改动即时生效（applies: live）。桥接进程会轮询 DSH settings 的 qq-mode；"
                + "设置不可用时回退读 state/mode.json。"
          )
        ];

        return react.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px", padding: "4px 0" } },
          children
        );
      }

      // 该槽位由 dsh-client-ui-settings-plugins 声明；inject 会等到它出现再注册。
      slots.inject("settings.plugin.item", () =>
        slots.register({ name: "settings.plugin.item", key: NAMESPACE }, QqModeCard)
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
