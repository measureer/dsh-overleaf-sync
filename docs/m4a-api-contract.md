# M4a 接口契约（Host ↔ 浏览器）

> 本文是 GUI 与 Host 之间的**唯一**约定。Host 侧实现见 `src/server/`，客户端实现见 `src/client/`。
> 设计背景见 [design.md §14](design.md)。

## 1. 传输

- 全部 `POST`，路径前缀 `/overleaf/api/`，同源，`Content-Type: application/json`。
- 响应一律 `application/json; charset=utf-8`，信封：

```jsonc
{ "ok": true,  "value": <payload> }
{ "ok": false, "code": "E_AUTH_REQUIRED", "message": "人话说明", "hint": "可选的下一步" }
```

- HTTP 状态码：成功 `200`；参数错误 `400`；未登录/凭据过期 `401`；无权限 `403`；不存在 `404`；设置冲突 `409`；其它 `500`。
  客户端**只看信封 `ok`**，状态码只用于日志与 `fetch` 语义。
- 请求体上限 256 KiB；超限 `413`。空体视为 `{}`。
- 同源校验：Host 拒绝 `Sec-Fetch-Site: cross-site` 的请求（`403`，`E_CROSS_SITE`）。

## 2. 路由表

| 路径 | 请求 | 成功时 `value` |
| --- | --- | --- |
| `/overleaf/api/status` | `{}` | `StatusSummary`（见 §3.1） |
| `/overleaf/api/login` | `{ cookie, csrfToken?, baseUrl? }` | `{ baseUrl, hint? }` |
| `/overleaf/api/logout` | `{}` | `{}` |
| `/overleaf/api/projects` | `{ refresh?: boolean }` | `ProjectListEntry[]` |
| `/overleaf/api/validate-path` | `{ path: string, projectId?: string }` | `{ ok, resolved, problems: string[] }` |
| `/overleaf/api/pick-directory` | `{ probe?: boolean }` | `{ kind: 'native' \| 'browse' \| 'unavailable', path: string \| null }` |
| `/overleaf/api/link` | `{ projectId: string, localRoot?: string }` | `LinkRecord` |
| `/overleaf/api/pull` | `{ projectId?: string, force?: boolean }` | `PullSummary` |
| `/overleaf/api/push` | `{ projectId?: string, dryRun?: boolean }` | `PushSummary` |
| `/overleaf/api/diff` | `{ projectId?: string, path: string }` | `DiffSummary` |
| `/overleaf/api/conflicts` | `{}` | `ConflictEntry[]`（见 §3.2） |
| `/overleaf/api/journal` | `{ limit?: number }` | `JournalEntry[]` |
| `/overleaf/api/settings.describe` | `{}` | `{ writable, fields, revision }`（见 §3.3） |
| `/overleaf/api/settings.update` | `{ patch: object, expectedRevision?: number }` | 同 `settings.describe` |

`ProjectListEntry` / `LinkRecord` / `PullSummary` / `PushSummary` / `DiffSummary` 的形状与 `src/service.ts` 的同名类型一致，字段名原样透传。

`pick-directory` 由宿主可选的 `ctx.directoryPicker` 支撑（桌面端解析为 `native`，即系统「选择文件夹」对话框）：
- `probe: true` 只回答能力，不弹窗 —— 页面加载时用它决定显示「选择目录」还是「校验路径」；
- 不传 `probe` 时弹窗等待用户，`path` 为用户选中的绝对目录，取消为 `null`；
- `browse` / `unavailable` 表示该宿主没有系统选择框，页面保留手动输入 + `validate-path` 兜底。


### 2.1 StatusSummary（GUI 视角，`src/server/types.ts`）

```ts
interface StatusSummary {
  baseUrl: string
  authenticated: boolean
  credential?: { hint?: string; savedAt?: string }
  current?: {
    projectId: string
    projectName: string
    localRoot: string
    files: number
    remoteVersion?: number
    lastPullAt?: string
    git?: { root: string; mode: 'own' | 'parent' | 'none'; head?: string }
  }
  projects: Array<{ projectId: string; projectName: string; localRoot: string; files: number; linkedAt: string }>
  pending: { localChanges: number; conflicts: number }
  text: string            // 一行摘要，给人看
}
```

### 2.2 ConflictEntry

```ts
interface ConflictEntry {
  path: string          // 项目内相对路径（主文件）
  copyPath: string      // 远端副本的相对路径，如 main.remote-20261023T013000.tex
  at: string            // ISO 时间
  strategy: 'keep-both' | 'keep-local' | 'keep-remote' | 'auto'
}
```

### 2.2b diff 的 `path` 是必填的

`/overleaf/api/diff` 每次只对比**一个文档**：Host 需要 `joinDoc` 才能拿到远端文本，
全项目 diff 会让 GUI 在一次点击里打开几十个文档。项目级的“有多少文件变了”由
`status.pending.localChanges` 提供（本地哈希对比基线，不联网）。

### 2.3 settings 视图

```ts
interface SettingsView {
  writable: boolean                       // ctx.settings.writable；false 时页面只读
  revision: number                        // 写回时必须带回
  fields: Array<{
    key: string                         // 点路径，如 git.autoInit；同时是 locale 字典键
    type: 'string' | 'boolean' | 'number' | 'enum'
    value: unknown
    label?: string                      // 中文标签；客户端也可优先用自己的 locale
    default?: unknown                   // 配置条目未覆盖时的 schema 默认值
    group?: 'strategy' | 'advanced'     // 主表单 / 「高级」折叠区
    options?: string[]                  // type === 'enum'
    min?: number
    max?: number
    description?: string
  }>
}
```

只有**可编辑字段**（配置里声明了 `.volatile()` 的项）出现在 `fields` 里；凭据类字段永远不出现。
`label`/`default`/`group`/`min`/`max` 都是**可选**的：客户端可以只用 `key` + 自己的 locale 字典渲染，
Host 提供的这些字段只是省一次映射。

## 3. 行为约定

- **登录**：`login` 内部先 `whoami` 验证 cookie，成功才落盘凭据；失败 `E_AUTH_INVALID`。响应里不回显 cookie。
- **绑定**：`link` 前 Host 侧必须 `realpath` + 越界校验；目录已存在且非空且不是本项目目录时返回 `E_LOCAL_DIR_CONFIRM_REQUIRED`（客户端据此弹确认，再带 `force: true` 重发）。
- **写远端**：`push` 的 `dryRun` 默认 `true`；`dryRun: false` 时若 `confirmRemoteWrite` 为真，仍需客户端二次确认（由 `POST /overleaf/api/push` 的 `confirm: true` 显式表达），否则 `E_CONFIRM_REQUIRED`。
- **幂等**：`status`/`projects`/`conflicts`/`journal` 无副作用；其余动作不做隐式重试。
- **并发**：同一时刻只允许一个 `pull`/`push`（Host 侧互斥锁，按 `projectId` 分桶），冲突时 `E_BUSY`（`409`）。
- **非信封响应**：DSH Web 层自己的 `401`/`404`/HTML 页面不带信封。客户端必须把「不是 `{ok:...}` 的响应」统一映射成 `E_NO_ROUTE`（提示「Host 侧未就绪」，并给重试），不能当成业务错误或直接白屏。
- **两种 409 靠 `code` 区分**：`E_SETTINGS_CONFLICT`（配置 revision 过期）与 `E_BUSY`（同步操作互斥）；UI 提示与重试动作完全不同。
- **「用默认目录」**：`validate-path` 的 `path` 必填，所以留空时客户端应先用 `localRootPattern` 展开一个预览值（把 `{project}` 换成项目名）送去校验；真正 `link` 时才省略 `localRoot`，由 Host 决定最终路径（含去重后缀）。

### 3.1 已登录用户的展示

`status.credential` 只有 `hint`（用户自填标签）与 `savedAt`，**没有 email**：Overleaf 的 `whoami`
响应并不稳定地返回邮箱，我们不在登录时编造这个字段。设置页显示「已保存凭据 · <hint> · <savedAt>」即可，
`E_AUTH_EXPIRED` 时徽章变红并提供「重新登录」。

## 4. 客户端要求

- 只用 `fetch`，不引入 HTTP 库；`AbortController` 取消。
- 所有数字与状态**不缓存**：面板/页面重挂载后从 `status` 重拉。
- 渲染错误必须自己兜底（`RenderBoundary`），单个区块崩溃不能白屏。
- 文案走 `ctx.locale` 字典（`locale/zh-CN.json`、`locale/en.json`），不硬编码中文。
