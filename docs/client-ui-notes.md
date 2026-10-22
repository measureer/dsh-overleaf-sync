# DSH 客户端插件 UI 契约调研（设置页 / 侧边栏）

调研 DSH Web GUI 的**客户端（浏览器侧）插件 API**。只写有源码/官方 README 行号支撑的事实；无证据处标注「未找到证据」。Node 侧契约（`apply(ctx, config)`/`defineTool`/`cordis.patch.yml`）见 [dsh-plugin-api-notes.md](dsh-plugin-api-notes.md)，本文不重复。

**证据路径约定**：`BS`=`C:\Users\admin\.dsh\profiles\desktop\node_modules\dsh-better-sidebar`（唯一带完整 `src/client/**` TS 源码的客户端 UI 插件，v0.28.0）；`MN`=`...\node_modules\dsh-mnemon`（仅编译产物，对照写法）；`FS`=`...\node_modules\dsh-free-search`；`DSH`=`C:\Users\admin\AppData\Local\Temp\dsh-asar\x\dsh\node_modules\@deepseek-ai`（由 `resources\app.asar` 解出，脚本 `%TEMP%\dsh-asar\asar.py`）。

---
## 1. 清单与加载
**结论一句话**：`package.json` 只需 `exports["./client"]` + `dsh.client.platform: "web"`；**没有** `dsh.client.entry` 字段。客户端入口模块形状与 Node 侧一致（`export const inject` + `export function apply(ctx)`），但产物不是 ESM，而是 `window.__ModuleLoader__.load({ id, factory })`。

`DSH/dsh-client-modules/README.md:34`（包契约原文）：
```
A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`,
exports a `./client` bundle, and lists any non-baseline module requests under
`dsh.client.external`. The host half turns each declaration into a served bundle under `/plugins`
```
`DSH/dsh-client-modules/lib/index.js:172-183`（入口解析——即「无 entry 字段」的反证）：
```js
function clientExportOf(pkgName, exportsField) {
	const client = exportsField["./client"];
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) { const fallback = client.default; if (typeof fallback === "string") return fallback; }
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}
```
`DSH/dsh-client-modules/lib/index.js:66-73`（`dsh.client` 被读取的**全部**字段）：
```js
if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
```
`BS/package.json`（真实清单节选）：`"exports": { ".": "./lib/index.js", "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } }`；`"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-modules"] } }`。

`DSH/dsh-client-modules/lib/index.js:414-438`：排序（provider 先于 consumer）**只看 `external`**，`inject` 不建边；自请求与环直接抛错。`dsh.client.inject` 是否参与任何行为 → **未找到证据**。

客户端入口真实形状，`BS/src/client/index.tsx:53`：`export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection', 'remote', 'remote.session']`。同文件 `:44-52` 注释：`remote` 与 `remote.session` **两条都要列**，Cordis 校验嵌套属性访问，缺一条抛 `cannot get property "remote.session" without inject`，且该错误从渲染路径抛出会把整个面板变白。

**对 overleaf-sync 的用法建议**：`package.json` 加 `"exports": { ".": "./lib/index.js", "./client": { "types": ..., "default": "./lib/client.js" } }` 与 `"dsh": { "client": { "platform": "web" } }`；不要发明 `entry`。client 入口先只写 `export const inject = ['slots']`（用到会话再加 `'sessions'`）。

---
## 2. 设置页
**结论一句话**：两条互斥的路。**(A) 零代码**：插件 Config 有 schema 即自动出现在 Settings→Plugins 表单。**(B) 自绘页**：注册 `settings.section` slot，props = `PropsRuntime<'settings.section'>` + 自己 `inject()` 的字段。写回配置**不经**客户端 settings RPC（第三方命名空间不被服务），必须 Node 侧 `ctx.inject(['settings'], sctx => ...)` 用 `sctx.settings.describe()/update(ns, patch, expectedRevision)`，再由插件自己的 webServer 路由暴露。

`DSH/dsh-settings/README.md:39`（自绘页的**官方开关**）：
```
A plugin that ships its own page registers `configure({ auto: false }, ctx.fiber)` as an effect inside
an optional `ctx.inject(['settings'], ...)` child from `apply` ... The policy does not remove
configuration reads or writes.
```
页面注册，`BS/src/client/index.tsx:458-464`：
```ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'better-sidebar', order: 100,
  label: () => t('settingsNav'), inject: () => ({ store: sidebarStore, service }),
}, SideCardSection))
```
组件契约，`BS/src/client/SideCardSection.tsx`：`:55` `import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'`；`:54` `import type {} from '@deepseek-ai/dsh-client-ui-settings/client'`（纯类型 import，只为合并 `'settings.section'` 的 SlotMap）；`:78` `export type SideCardSectionProps = PropsRuntime<'settings.section'> & SideCardSectionInjected`；`:640` `export function SideCardSection({ store, service }: SideCardSectionProps)`。

为什么必须自建路由，`BS/src/index.ts:610-615`：
```
The DSH settings RPC domain only serves allowlisted namespaces (api-proxy exposedNamespaces), so the
client reads and writes THIS namespace through the plugin's own fenced /sidebar routes, which call the
seam in-process — no configuration-client gate involved.
```
Node 侧接法，`BS/src/index.ts:1335-1352` + `:1395-1404`：
```ts
ctx.inject(['settings'], (sctx) => {
  const ns = ownEntryId(ctx)                    // 命名空间 = profile 里的插件行 id，不是包名
  ctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), '...settings page policy')
  settingsFace = { get: () => viewOf(),         // sctx.settings.describe({ redactSecrets: true }).find(d => d.ns === ns)
    update: async (patch, expectedRevision) => { await sctx.settings.update(ns, patch, expectedRevision); return viewOf() } }
})
```
路由侧，`BS/src/index.ts:1092-1116`（作为 `/sidebar/api/<method>` 的一个方法；`ApiMethod = (payload, signal?: AbortSignal) => Promise<unknown> | unknown`，`:607`）：
```ts
'settings.update': async (payload) => {
  const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined
  try { return await settings.update(patch, expectedRevision) }
  catch (error) {
    if (error instanceof SettingsConflictError) throw new SidebarError('settings-conflict', error.message, 409)
    throw new SidebarError('settings-rejected', ..., 400)
  }
}
```
`DSH/dsh-client-ui-settings/README.md:34-44`：`ctx.configForms.get(entryId)` 给带 revision 的 snapshot（`value`/继承 `base`/raw `user`/`writable`），`settings.describe.writable` 是「这次写是否被接受」的权威；feature 页统一注册 `settings.section`（shell 在 `sidebar.settings`，Plugins 区托管 `settings.plugins.tab`）。

**对 overleaf-sync 的用法建议**：走 (B)。cookie/CSRF 用 `redactSecrets` 的 describe 只回显「已设置」标记（README:49 机密值以 presence marker 下发）；本地文件夹用一个 Input + Host 侧路径校验；写回一律 `{patch, expectedRevision}`，409 当冲突提示，绝不覆盖。

---
## 3. 侧边栏
**结论一句话**：右侧 = 「tab 类型注册」+「body slot（`sidebar.right.pane.tab`，key 为类型 id）」两段式；左侧 = 「`sidebar.panellist` 列表项」+「`main` keyed slot」，必须嵌套 `ctx.slots.inject`。若已装 better-sidebar，**第三方正规入口是 `ctx.betterSidebar.registerTab(descriptor)`**：一次调用同时得到宿主原生右侧 tab 类型 + 标题槽 + guide 胶囊。

右侧两段式，`DSH/dsh-client-ui-sidebar-right/README.md:81-84`：
```
ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)
```
`id` 全局唯一（重复注册抛错）；`patterns` 是对 `dsh-resource://` 地址的 glob；`priority` 为 `extension` > `builtin` > `fallback`；body 用框架给的 `useTabInfo()` 读 `{ sidebar, panel, tab }`。导航 `:93`：`ctx.sidebarRight.openTab(kind, options?)` / `openResource(address, options?)`，options 含 `revealIfOpened`/`replaceTab`/`paneId`/`preferNewPane`。**`:88` 明确：没有 pane 级 action seat，没有折叠态控件 seat。**

`BS/src/client/native/index.ts:302-330`（真实注册 + 会话隔离）：
```ts
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab', key: id,
  inject: (sessionId: string) => ({ ...injected, ...params, sessionId }),
}, NativeTabBody))
ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: id, inject: ... }, NativeTabTitle))
```
会话隔离机制：右侧布局按 sessionId 存 localStorage（README`:74`，键 `dsh.sidebar-right.v1.<sessionId>`），body 的 `inject(sessionId)` 形参即当前会话；无会话（hero 屏）时右侧什么都不渲染（`:141-147`）。

better-sidebar 的对第三方服务，`BS/src/client/service.ts:4`/`:614-617`/`:168`：
```ts
// :4 发布为 ctx.betterSidebar，暴露 registerTab / registerFileViewer，均返回 disposer
export interface BetterSidebarService {
  registerTab(descriptor: TabDescriptor): () => void; registerFileViewer(...): () => void; registerFileIcon(...): () => void
  getTabs(); openTab(...); closeTab(...); subscribe(...); ...
}
// :168 TabDescriptor
id(唯一，也是 SidebarTab.type)/title: string|(()=>string)/description?/icon?: ReactNode|((size)=>ReactNode)/order?(默认100)/hidden?/keepMounted?
```
`BS/src/client/service.ts:188-198` 注释：不加 bottom-workbench 标记时，**每个注册类型也会自动变成 DSH 原生右侧边栏的 tab 类型**（一个 guide 胶囊 + 一个 host 可打开的 kind）。

左侧两段式，`DSH/dsh-client-ui-sidebar/README.md:38` + `MN/lib/client.js` 实证：
```js
const stopNative = ctx.slots.inject("main", () => ctx.slots.inject("sidebar.panellist", () => {
  const stopMain = ctx.slots.register({ name: "main", key: SKILLS_PANEL_ID, inject: () => ({ ...services, render, navigation }) }, SkillsMainPanel)
  stopIcon = ctx.slots.register({ name: "sidebar.panellist", id: SKILLS_PANEL_ID, order: 31, label: () => services.t("skills.label"), locale: "mnemon" }, SkillsSidebarIcon)
  return () => { stopIcon?.(); stopMain() }
}))
// 导航：ctx.layout.selectPanel(SKILLS_PANEL_ID) / selectPanel(null)
```
README 警告：**选中不存在的 `main` entry 会抛错且不改当前选择**——两段注册必须成对、失败一起回滚（`MN` 同段 catch 即此意）。

**对 overleaf-sync 的用法建议**：优先 `ctx.inject(['betterSidebar'], ...)` + `registerTab`（省掉 title/guide/持久化）。不想强依赖它则用 `sidebarRightTabs.register({ id: 'overleaf', kind, title })` + `sidebar.right.pane.tab`，面板里用 `inject(sessionId)` 区分项目。冲突列表放 tab body 内，别指望 pane 级 action 槽。**左侧栏不要占**——overleaf 是项目级工具，右侧更像 IDE。

---
## 4. UI 原语与样式隔离
**结论一句话**：`@deepseek-ai/dsh-client-ui-primitives` 一个包给全（按钮/输入/开关/弹窗/菜单/徽章/图标/Markdown/diff/终端/剪贴板）；样式用 **CSS Modules + 全局 layout.css**，构建时内联进 JS、运行时插 `<style>`——**不要自带 UI 库**。

`BS/src/client/**` 对 primitives 的 import 实测共 **76 个导出**，关键子集：
```
Button Input Switch Modal Menu MenuSurface MenuEntry MenuItem Tooltip Pill Tag TagTone
StateDot StateDotState ConnectionIndicator FileTypeIcon MarkdownText MarkdownDelegateProvider
DiffBlock DiffHunk DiffBlockLabels JsonTree ReadBlock ReadBlockLine TerminalBlock
useDismissOnOutsidePointer writeClipboard IconProps + 45 个 Icon*Regular
```
（脚本统计：`BS/src` 下所有 `import { ... } from '@deepseek-ai/dsh-client-ui-primitives'` 的并集。**无** List/Table/Badge 之名——列表自己 map，徽章用 `Pill`/`Tag`/`StateDot`。）

样式，`BS/src/client/index.tsx:33-34`：`import css from './sidebar.module.css'` / `import './layout.css'`。CSS 被 tsdown 打成字符串，运行时插 `<style>`（`BS/lib/client.js` 内 15 处 `document.createElement("style")`）；`BS/src/client/css-modules.d.ts` 给 `.module.css` 提供类型。

**对 overleaf-sync 的用法建议**：状态徽章 `StateDot`（同步中/已同步/冲突）+ `Pill`；动作按钮 `Button` + `IconRefreshOutlineRegular`；日志用等宽 `TerminalBlock` 或自己的 `<pre>`；图标一律 `Icon*Regular` 保持与 shell 一致；自己的样式只写 `*.module.css`。

---
## 5. 与 Host 通信
**结论一句话**：三条路。(1) `ctx.remote.<命名空间>.<方法>()` 只能调**平台已存在**的命名空间（session/settings/workspace…），返回 `{ ok, value? }` 信封；(2) 自建 webServer 路由 + 同源 `fetch`，这是第三方插件唯一**可扩展**的请求-响应通道；(3) Host→client 推送：`ctx.remote.$on(event, cb)` 订阅平台转发事件，或自建 WebSocket/SSE。

(1) `BS/src/client/open-in-app.ts:58-64`（结构化类型即契约）：
```ts
interface SessionRemote {
  canOpenWorkspacePath(): Promise<{ ok: boolean; value?: boolean }>
  workspacePathApplications(request: { path: string }): Promise<{ ok: boolean; value?: readonly RawFileApplication[] }>
  openWorkspacePath(request: { path: string; action?: 'reveal'; application?: string }): Promise<{ ok: boolean }>
}
```
同文件 `:93-101`：`ctx.get('remote')` 在缺 inject 时抛错，必须 `try/catch` 降级为「无此能力」而不是让渲染挂掉。

(2) `BS/src/client/api.ts:1-9`（全插件唯一 RPC 通道）：
```
Typed fetch wrapper over the /sidebar JSON API. Every call posts through hostRouteUrl to
`/sidebar/api/<method>` with the sessionId and — when known — the session's cwd ...
Failures surface as SidebarApiError with the wire code.
```
Host 侧挂载 `BS/src/index.ts:1449-1488`：`{ path: '/sidebar/api', ... }` + `api[method]` 分发表（`:1488` 日志 `'dsh-better-sidebar: /sidebar/api routes'`）；`ApiMethod = (payload: unknown, signal?: AbortSignal) => Promise<unknown> | unknown`（`:607`，**带取消信号**，无超时常量）。

(3) 推送，`BS/src/client/index.tsx:365`：
```ts
const offRemote = remote?.$on?.('settings/document-updated', () => { void sync().catch((error) => { fail('sync', error) }) })
```
即 `ctx.remote.$on('<事件名>', handler)` 返回取消函数。自建双向通道见 `BS/src/sidechat-push.ts:1-28`（host 侧 WebSocket `/sidebar/ws/sidechat`，帧**只带失效通知**，客户端凭 `afterSeq` 重拉）与 `BS/src/client/use-sidechat-push.ts:1-20`（每 tab 一 socket，指数退避 1s→15s，隐藏即关）。DSH 自己的推送通道是 SSE `/plugins/events`（`DSH/dsh-client-hmr/README.md`）。

给第三方新增 `ctx.remote` 命名空间 → **未找到证据**（`DSH/dsh-api-remotes/README.md:14/:32`：命名空间由平台 composition 的 Typert 生成，业务包「depend on this facade rather than the Gateway implementation」）。

**对 overleaf-sync 的用法建议**：Node 侧起 `/overleaf/api/<method>`（status/pull/push/conflicts/log）+ `/overleaf/events`（SSE 推同步进度与冲突增量）；client 用 `fetch` + 同款错误码（`overleaf-conflict` 409 等）与 `AbortSignal` 取消。`ctx.remote` 只用来拿已存在的会话/工作区信息（sessionId、cwd）。

---
## 6. 构建与分发
**结论一句话**：官方用 **tsdown** 出两个入口（Node `lib/index.js`、浏览器 `lib/client.js`）；浏览器产物**不是 ESM**，是 `window.__ModuleLoader__.load({ id, factory })`；externals 固定 7 个 React/Cordis/UI 包；`files` 必须含产物与 `src`；兼容性写 `engines.dsh` + `dsh.client.platform`。

`BS/lib/client.js` 头部（真实产物形状）：
```js
window.__ModuleLoader__.load({ id: "dsh-better-sidebar", factory: (require) => {
  var module = { exports: {} }; ...; exports.apply = apply; exports.inject = inject; return module.exports } })
```
`BS/src/client/chunk-loader.ts:55-81`（externals 权威清单，注释自称 `tsdown.config.ts` 的 mirror）：
```ts
export const CHUNK_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
]
```
`DSH/dsh-client-modules/README.md:50`：shell 预置**冻结**模块表 `PLATFORM_MODULES`，动态 bundle 的 externals 只针对该基线解析，`dsh.client.external` 只追加精确的非基线请求；type-only import 被擦除、不产生请求。`:54` 宿主服务的是**构建好的** `lib/client.js`，缺产物启动即报错。`:72` 执行 bundle 只注册 factory，模块体副作用（含 CSS 注入）在 materialize 时跑；`require.async("./client.<name>.js")` 是 tsdown 拆 chunk 的形式。`:78` combo 路由 `/plugins/??...&rev=...`，revision 由 mtime/ctime/size 派生。

`BS/package.json`：`scripts.build = "rm -rf lib && tsc -p tsconfig.build.json && tsdown"`、`bundle = tsdown`、`watch = tsdown --watch`，devDep `tsdown ^0.22.2`；`files` 含 `lib/index.js`、`lib/client.js`、`lib/client-{editor,locale,mermaid,terminal}.js`、`lib/types/**/*.d.ts`、`src`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`。客户端依赖只写 **peerDependencies**（`@deepseek-ai/dsh-client-ui-*` 均 `^0.2.1-rc.1`，`react`/`react-dom` `^18.2.0`）。

兼容声明两种真实写法：`FS/package.json` 的 `"engines": { "dsh": ">=0.1.7-rc.1" }` + `"compatibility": { "dshReleases": { "0.1.7-rc.1": "compatible" } }`；`DSH/dsh-package-manifest/README.md:53` 说 `engines.dsh` 是 SemVer range，`:93` 说**当前不强制校验**、纯声明。

开发期热更：`DSH/dsh-client-hmr/README.md`「Run `pnpm run dev:web` ... rebuilt plugins are then swapped into the running browser automatically, one at a time」；preset 在所有 package-local chunk 写完后 stamp `lib/client.js`；唯一配置项 `pollIntervalMs` 默认 `500`。

**对 overleaf-sync 的用法建议**：照 better-sidebar 的 tsdown 形态（官方 client preset）；先出单文件 `lib/client.js`，不进 chunk；`files` 保留 `lib` + `src`；peerDeps 声明 ui-slots + ui-primitives + react 18，避免双 React。

---
## 7. 限制与坑
**结论一句话**：客户端是**纯浏览器沙箱**——没有 Node、没有 fs、只能同源 fetch；渲染错误不自动兜底，必须自己包 boundary；HMR 会丢 React 状态；settings 的第三方命名空间必须自建路由。

1. **不能读本地文件系统**。`BS/src/client/**` 无任何 `fs`/`path` 引用；文件操作全在 Node 半边的 `BS/src/fs-*.ts`、`fs-tree.ts`、`fs-watch.ts`，客户端只经 `/sidebar/api/*` 请求。
2. **外网 fetch**：`BS/src/client` 内 `grep "fetch('http"` 零命中，全部走同源路由；页面 CSP/白名单策略 **未找到证据**。原则：不要在客户端直连 Overleaf。
3. **渲染抛错**：`DSH/dsh-client-ui-renderer/README.md` 全文无 error boundary 表述——框架不兜底。`BS/src/client/RenderBoundary.tsx:10-30` 自己实现两级：ROOT（`css.boundaryError`，保住整个 shell）与 PER-TAB（`css.tabBoundaryError`，只坏一个 pane），注释原话「a tab crash must never take down the whole sidebar」。
4. **热重载**：每次成功 reload 重新执行 bundle 并重挂插件，**React state 丢失**；session/workspace/connection 状态存活。构建失败保留旧 bundle 继续跑；激活失败**不回滚**（HMR README「Failure policy」）。
5. **inject 缺失 = 白屏级故障**：`BS/src/client/index.tsx:44-52` 明确 `remote.session` 漏写 inject 会抛错，从渲染路径抛出时整块面板变白。取服务要么走 inject，要么 `try/catch` 降级。
6. **`settings.describe()` 只列 ACTIVE fiber**：loader 未 settle 时查不到自己的行，legacy 导入会静默「no form」。必须 `await ctx.loader.await()`（`BS/src/index.ts:1411-1416` 注释）。
7. **Host 侧收不到 `settings/document-updated`**：事件在 settings 服务自己的 context 上发，插件 fiber 不在其祖先链，「a listener here would never run」（`BS/src/index.ts:1396-1401`）。要么客户端 `ctx.remote.$on`，要么自己轮询。
8. **右侧布局不跨设备**：localStorage 按 sessionId；无 session 时右侧空白；`title(address)` 在打开瞬间固化（README`:74/:141-147`）。
9. **首帧等待所有 client entry**（`DSH/dsh-client-ui-renderer/README.md:94-95`）：无按 entry 懒加载、无 Suspense。client 入口要极轻，重列表/编辑器再 `require.async` 拆 chunk。
10. **设置写回必须自建路由**：settings RPC 域只服务 allowlisted 命名空间（`BS/src/index.ts:610-615`），第三方直接调会被拒。
11. **Node 侧与 client 侧共享类型**：同一批 `src/*.ts` 被两侧 `import type`——`BS/src/client/api.ts:12-30` 直接 `import type { SidebarSessionEvent } from '../context-types.ts'`，`BS/src/sidechat-push.ts:26` 从 `./context-types.ts` 取 `Context`。必须 `import type`，否则会被打出运行时边（`DSH/dsh-client-modules/README.md:50`）。

---
## 附录：明确「未找到证据」的点
- `dsh.client.entry` 字段：不存在；入口只由 `exports["./client"]` 决定（`dsh-client-modules/lib/index.js:172-183` 反证）。
- `@deepseek-ai/dsh-client-ui-slots` / `-ui-primitives` 的包级 README：asar 内**没有**这两个包目录（是 shell 静态模块表项），API 只能从真实 import 与类型 import 推断。
- `dsh.client.inject` 是否参与排序/校验：`orderByModuleGraph` 只用 `external`（`:414-438`），`inject` 仅原样进 graph row（`:407`）。
- 客户端 fetch 外网的 CSP/白名单策略：无证据。
- 第三方自建 `ctx.remote` 命名空间的注册 API：无证据（由平台 Typert assembly 生成）。
- 右侧 pane 级 action 槽、折叠态控件槽：README `:88` 明确**不存在**。
- 插件侧 RPC 超时机制：better-sidebar 只用 `AbortSignal`（`:607`），无超时常量。
