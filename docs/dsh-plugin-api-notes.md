# DSH 插件开发契约（已确认要点）

> 取证方式：从 `C:\Users\admin\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 解包官方包到 `C:\code\dsh-overleaf-sync\.tmp-docs\`、`.tmp-lib\`（包内路径与 asar 一致：`dsh/node_modules/@deepseek-ai/<pkg>/…`）。下文出处省略公共前缀 `dsh/node_modules/@deepseek-ai/`。DSH 本体 0.2.1-rc.2，Cordis 4.0.5。

## 1. 插件模块形状

- Cordis 插件 = 函数 `(ctx, config)`、类，或 `{ apply(ctx, config) }` 对象（`cordis/src/registry.ts:92-133`）。
- 可用元数据（`registry.ts:100-111`）：`name`、`Config`（StandardSchemaV1 校验器，schemastery 满足）、`inject`（依赖服务数组或 name→intercept 映射）、`provide`、`intercept`。
- 官方具名导出约定（`dsh-tool-fs/lib/index.js:1186-1231`、`dsh-tool-todo/lib/index.js:11,12,20,196`）：`export const name`、`export const inject`、`export const Config`、`export function apply(ctx, config)`，末尾 `export { Config, apply, inject, name }`。
- `ctx.plugin(plugin, config)` 启动并返回 Fiber（`registry.ts:185,316-336`）；`ctx.inject(deps, cb)` 等价 `ctx.plugin({inject, apply:cb})`，依赖变化时自动卸载重跑（`registry.ts:176,300-302`）。Config 不合法则**不启动**（`dsh-app-boot/README.md:102`）。

## 2. 注册模型可见工具（核心）

- API 是 **`ctx.tools.register(defineTool({...}))`**（不是 `ctx.tool(...)`）；`dsh-tools` 提供服务 `ctx.tools`（`dsh-tools/README.md:30,45`）。
- `register(definition)` 返回**精确的 disposer**（注销该工具）；同一层重名、以及保留名 `run_code` 都会抛错（`dsh-tools/lib/index.js:2974-2984`）。
- `defineTool` 字段白名单（`dsh-tools/lib/index.js:838-897`）：`name`、`description`、`parameters`、`output.{schema,render,presentationMeta}`、`execute(args, exec)`、`deferLoading`、`timeoutMs`（必须正有限数）、`projectContent`、`finalizeContent`、`presentCall`、`presentResult`、`isConcurrencySafe`。`output` 必须给 `{schema, render}`，否则 `TypeError`（`:2978`）。
- 最小官方示例（`dsh-tools/README.md:45-61`）：
  ```ts
  ctx.tools.register(defineTool({
    name: 'read_file', description: 'Read a file from disk.',
    parameters: { path: { type: 'string', required: true, description: 'Absolute file path' }, offset: { type: 'number' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) { return readFile(args.path, { encoding: 'utf8', signal: exec.signal }) },
  }))
  ```
- 真实完整样本：`dsh-tool-todo/lib/index.js:95-193`（array/object 参数、`enum`、`output.render`、`presentCall`、`exec.agent.session.append`）；`dsh-tool-fs/lib/index.js:1186-1231` 演示条件注册与 `ctx.inject(["attachments"], …)` 只在服务可用时注册。

**参数 schema DSL（不是 zod、不是裸 JSON Schema）**：
- 允许类型 `string|number|integer|boolean|null|array|object|json` 与 exact-one `oneOf`（`dsh-tools/README.md:64`）；精确词表见 `dsh-tools/lib/types/schema.js:118-205`。
- 注解键 `description/title/default/examples`；属性节点额外允许 `required`，且**只能字面 `true`**（`schema.js:66-71`）。`object` **必须显式给 `additionalProperties: boolean`**，否则报错；`array` 可选 `items`；标量可选 `enum`/`const`；`oneOf` 与 `type` 互斥。其他键报 `<path>.<key> is not supported by the value schema DSL`。
- 调用前自动 `validateJsonSchemaValue`，违规抛 `ToolArgsError`（`dsh-tools/lib/index.js:838-897`）。

**返回值与图片**：`output.render(args, value)` 返回 content blocks；文本 `{type:'text',text}`，图片 `{type:'image', attachment: imageRefFromValue(...)}`（`dsh-tool-fs/lib/index.js:964-973`）。
- 结果含 image 时经 `exec.deferContext(...)` 作为下一轮 user-message 上下文（`dsh-tools/lib/index.js:1454`）；模型不支持图片输入时 read_image 直接抛错（`dsh-tool-fs/lib/index.js:916`）。

## 3. 执行管线、事件、取消与超时

- 三段 waterfall（`dsh-tools/lib/index.js:3321,3427,3600`）：`tools/pre-execute`（`exec` → `{kind:'allow'}` 或拦截）、`tools/execute`、`tools/post-execute`（`exec, result` → `{kind:'accept'}`；accept 不能同时替换 value 与 content，失败结果不可换 value）。另有 `tools/change`、`tools/list`、`tools/result`。
- 相关真实事件名：`agent/pre-step|request|request-error|status|turn-stopping`、`session/event`、`fs/observed`、`fs/write-intent`、`approval/asked|decided|request|policy`。
- `execute(args, exec)` 实测字段：`agent`（可能 undefined）、`exec.agent.session`、`callId`、`signal`、`deferContext`（`dsh-tools/lib/index.js:1266,1424,1454,1531`）；其余字段未验证。取消靠把 `exec.signal` 透传给底层 IO（`dsh-tools/README.md:45`）；`timeoutMs` 只验证为正有限数（`:2981`），**超时/取消错误码未验证**。
- 错误要抛 `HarnessError` 子类才会填 `result.error` 的结构化 code（`dsh-tool-fs/lib/index.js:1168-1176`），普通 `Error` 会丢 code。卡片：Web 端由 `tool.call.toolview` 渲染器从 raw args/结果推导，**不消费 `presentCall` 返回值**（`dsh-tools/README.md:95`）。

## 4. 生命周期、服务与注入

- 生命周期：`ctx.effect(() => disposer, "label")` 立即执行、收集 disposer，返回的 disposer 或 fiber 卸载时逆序清理；fiber 已销毁时抛 `INACTIVE_EFFECT`（`cordis/src/fiber.ts:405-420`）。`ctx.on/emit/waterfall/bail/parallel` 见 `cordis/src/events.ts`；fiber 事件 `internal/plugin|status|config|update`（`events.ts:331-351`）。
- 服务：`class X extends Service` + 构造里 `super(ctx, "name")`，随 owner fiber 自动注销（`cordis/src/service.ts:42-59`）；`ctx.provide(name, value, check?)`、`ctx.get(name)`、`ctx.set(name, value)`（`cordis/src/reflect.ts:19-56,233-277`）。
- 定时器：`ctx.timeout/interval/throttle/debounce`（`ctx.setTimeout/setInterval` 是弃用别名），随 fiber 清理（`cordis-plugin-timer/README.md`）。
- 已确认存在的服务名（asar 内 `super(ctx, "…")` 扫描，节选）：`tools, fs, systemPrompt, workingDirectory, attachments, sessions, agents, agentLoop, llm, webServer, web, commands, skills, slots, approval, sandbox, sandboxPolicy, settingsController, settingsSchema, commands, jobs, subagents, workspaces, workspaceFiles, pluginManager, pluginPackages, sessionProjections, sessionSkillCatalog, terminalController, workingDirectory, storage, spillStore, timer, cordisInspect, remote`。完整 90+ 项可重跑同一条扫描。
- 官方插件 `inject` 实例：`dsh-tool-fs` → `["tools","fs","systemPrompt","workingDirectory"]`；`dsh-tool-todo` → `["tools","sessionProjections"]`；`dsh-remote-web` → `["webServer"]`。

> **服务读取的硬约束（2026-10-23 实测踩坑）**：Cordis 对**未通过 `inject` 声明**的服务做属性访问会直接抛 `cannot get property "<name>" without inject`（不是返回 undefined）。因此：
> - 插件需要可选服务（`webServer`、`settings`…）时，**只能用 `ctx.get(name)` 读取**（不存在时返回 `undefined`），绝不能写 `ctx.webServer`；
> - 把这类读取包进 `try/catch` 并准备「属性读取」兜底，才能在伪 Context 的单元测试里也跑通；
> - 该异常发生在 `apply()` 里会**整体中止插件加载**，且不显示在工具列表上，只能靠 diagnostics 或克隆 profile 复现。

## 5. 配置 schema 与热重载

- 用 schemastery：`import z from "@deepseek-ai/schemastery"`；`z.object({...})`、`.default(v)`、`.required()`（与 default 互斥）、`.description()`（`schemastery/README.md:42,241-253`）。样本：`dsh-tool-fs/lib/index.js:1194-1202`。
- profile 层：`$DSH_HOME/profiles/<name>/cordis.yml` 是根条目表（desktop 实为 `[]`），真正生效的是各 bundle 的 `dsh.bundle.patch` + profile 自己的 `cordis.patch.yml` + home 层 patch（`dsh-app-boot/README.md:50,61`）。
- patch 语法（`cordis-plugin-include/README.md`、`~/.dsh/profiles/desktop/cordis.patch.yml`）：顶层 YAML 数组；`- id/name/config` 覆盖同 id 条目（**整段替换，不深合并**），`- insert: [ {id,name,config} ]` 插入新条目，`!!js` 表达式在启动时求值；空 patch 文件会让启动失败，用 `[]` 禁用该层。
- 热重载：HMR 开启时 profile manifest 与两处用户 patch 被监听并重算（`dsh-app-boot/README.md:63`）；`fiber.update()` 走 `internal/update` waterfall，默认重启；仅 volatile 字段变化会被 Loader 直接提交到运行中的引用并 emit `loader/volatile-update`（`cordis-plugin-loader/README.md`）。`.volatile()` 的 schemastery 定义**未验证**。
- 未开 HMR 时改配置/装插件需重启；`plugin_manager` 工具与 CLI `dsh plugin …` 负责落盘（`dsh-plugin-manager/README.md:14,75,100`）。
## 6. 权限、审批与沙箱

- 审批服务 `ctx.approval`（`dsh-user-approval/lib/index.js:72-76`）；`request(req)` 需在**开着的 turn 内**调用，否则抛错（`:128-130`）；outcome 仅 `allowed-once/rejected/cancelled/unavailable`，无 allow-always（README:154）。policy 只有 `ask` / `never`；`never` 时不问直接拒（本会话即此模式，见 runtime context）。
- 沙箱工具模式（`dsh-tool-fs/lib/index.js:1088-1180`）：`ctx.fs.sandboxMode` 有值 = 有约束后端，此时需要 `ctx.sandboxPolicy`；写类工具在参数里追加 `sandbox_permissions`（枚举 `ESCALATION_TARGETS`）+ `justification`，执行时经 `approveEscalation(..., {approver: ctx.get("approval"), agent, callId, toolName, signal})` 才放宽；拒绝映射为 `FS_SANDBOX_DENIED` + `[sandbox: …]` 标记。
- 结论：插件自身**没有**「声明需要用户确认」的清单字段；要审批就显式调用 `ctx.approval.request(...)` / `approveEscalation(...)`，并自己 fail-closed。

## 7. 客户端 / GUI 扩展点

- 清单：`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }`，并 `exports["./client"]` 指向构建产物；host 把每个声明变成 `/plugins` 下的懒加载 bundle，**必须先 build 出 `lib/client.js`**，缺失会启动报错（`dsh-client-modules/README.md:34,38,54`；样本 `~/.dsh/profiles/desktop/node_modules/dsh-remote-web/package.json`）。
- 手写（免构建）bundle 约定：`window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { … exports.inject = ["slots"]; exports.apply = apply; return module.exports } })`（`dsh-remote-web/lib/client.js:1-9,2568-2620`）。
- 注册 UI：`ctx.slots.inject("<槽名>", () => ctx.slots.register({name, id, order, label}, Component))`，返回 disposer；同槽同 id 同优先级重复注册会抛错（同上 `:2585-2610`）。已确认槽名（README 扫描）：`settings.section`、`settings.plugins.tab`、`settings.onboarding`、`settings.models.provider-card`、`sidebar.settings`、`sidebar.footer.action`、`sidebar.workspaces`、`sidebar.toggle.badge`、`sidebar.right.pane.tab`、`conversation.input.overlay`、`conversation.content`、`conversation.chat.turnTail`、`shell.overlay`、`plugins.item`、`plugins.tab`、`plugins.row.config`、`plugins.bundle.config`、`plugins.detail.section`、`tool.call.toolview`、`tool.call.images`。
- Host 侧 HTTP：`ctx.webServer.register({ kind: "exact"|"prefix", path, handler(req,res) })` 返回 disposer（`dsh-remote-web/lib/index.js:5302`）。

## 8. 安装与打包

- profile `package.json` 的 `dsh.profile.bundles` 是有序 bundle 名数组，`dependencies` 提供实际包（本地开发用 `file:<绝对路径>`，实见 `~/.dsh/profiles/desktop/package.json`）；bundle 通过自己的 `cordis.patch.yml` 用 `insert` 挂条目（`dsh-remote-web/cordis.patch.yml`）。
- 发布：`dsh` 字段需 `manifestVersion: 1`（可选）+ `bundle.patch`（可多文件，按序应用）；兼容性用 `engines.dsh`（SemVer range，优先于 `peerDependencies`）或 `@deepseek-ai/dsh*` 的 peer 范围（`dsh-package-manifest/README.md:36-53`；`dsh-app-boot/README.md:52`）。官方包 peer 写法：`"@deepseek-ai/cordis": "~4.0.5"` + 各 `@deepseek-ai/dsh-*` 精确版本（`dsh-tool-todo/package.json`）。
- 市场：`dshmarket`/`plugin_manager` 走 `pnpm add`，装完需启用 bundle；无 HMR 时 `restart-required`（`dsh-plugin-manager/README.md:40,52,100`）。`dsh plugin add …` 的具体子命令名**未验证**。

## 9. 可直接照抄的最小骨架

```jsonc
// package.json（host-only 工具插件；patch 见 §5，最小形态即 - insert: [{id, name, config}]）
{ "name": "dsh-overleaf-sync", "version": "0.1.0", "type": "module", "main": "lib/index.js",
  "exports": { ".": { "default": "./lib/index.js" }, "./client": { "default": "./lib/client.js" }, "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } },
  "engines": { "dsh": ">=0.1.0-rc.6 <0.3.0-0" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" } }
```
```ts
// lib/index.js 的 TS 源形态
import z from '@deepseek-ai/schemastery'
export const name = 'overleaf-sync'
export const inject = ['tools', 'fs']
export const Config = z.object({ projectRoot: z.string().required(), autoPull: z.boolean().default(false) })
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'overleaf_status', description: 'Report local vs Overleaf sync state.',
    parameters: { project: { type: 'string', required: true, description: 'Overleaf project id or name' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) { return await statusOf(args.project, exec.signal) },
  }))
  ctx.effect(() => startWatcher(config, ctx), 'overleaf-sync watcher')
}
```
```js
// lib/client.js（免构建双半插件的浏览器半，见 §7 约定）
window.__ModuleLoader__.load({ id: 'dsh-overleaf-sync', factory: (require) => {
  const module = { exports: {} }
  module.exports.inject = ['slots']
  module.exports.apply = (ctx) => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'dsh-overleaf-sync', order: 40, label: () => 'Overleaf 同步' }, Panel))
  return module.exports
} })
```

## 10. 未验证 / 待确认

1. `exec` 完整字段表、超时/取消错误码；是否有比 `ctx.tools.register` 更高层的封装。
2. schemastery `.volatile()` 写法；设置页字段（`ctx.configForms`）如何从 Config 自动生成。
3. `dsh plugin add` 确切子命令与参数；`dsh-market` 上架流程。
4. 出网请求方式：服务名扫描结果中**没有** `http`（只有 `remote`、`llm`、`webServer`）；客户端官方构建工具链（tsdown/pnpm 脚本）与 `dsh.client.external` 白名单细节。

## 11. 运行时排障剧本（已验证可用）

1. **别动用户的 profile**：CLI 跑不了 `desktop`（报 `profile "desktop" is managed exclusively by the Electron application`）。克隆一份再启动：

   ```bash
   mkdir -p ~/.dsh/profiles/otcheck/node_modules
   cp ~/.dsh/profiles/desktop/{package.json,cordis.patch.yml} ~/.dsh/profiles/otcheck/
   rm -rf ~/.dsh/profiles/otcheck/node_modules/dsh-overleaf-sync
   cp -r ~/.dsh/profiles/desktop/node_modules/dsh-overleaf-sync ~/.dsh/profiles/otcheck/node_modules/
   sed -i 's#"dsh-overleaf-sync": *"link:[^"]*"#"dsh-overleaf-sync": "file:///C:/code/dsh-overleaf-sync"#' ~/.dsh/profiles/otcheck/package.json
   ```

2. **另起端口跑**：`dsh --profile otcheck --patch <disable-overlay> --port 2001 web`；启动日志会打印一个 cookie（`paste this cookie into the request to get access`）。
3. **逐路由探测**：先 `GET /` 得 401（说明鉴权正常），再带 cookie `POST /overleaf/api/status`：返回 JSON 信封 = 注册成功；返回 405 = **路由根本没注册**（Host 半侧没跑到）。
4. **对齐版本**：克隆树的模块版本必须与用户树一致（从用户日志 `正在加载插件 …@版本` 抄版本再补装），否则结论会被版本差异污染。
5. **两个进程可共存**：不同 `--port` 与 `DSH_HOME` 可并存；克隆 profile 默认绑定 desktop 的 `bot/default`，验证时不要在那里跑写操作。
