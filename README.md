# dsh-overleaf-sync

DSH（DeepSeek Harness）插件：把本地 LaTeX 文件夹与 Overleaf 项目双向同步，让 Agent 直接 `pull` / `push` / `diff` 你的论文。

思路参照 [measureer/overleaf-sync](https://github.com/measureer/overleaf-sync)（VS Code 插件）：不走 Git，而是复用 Overleaf 编辑器自己的协作通道（Socket.IO + OT），因此不需要付费的 Git 桥接。

**当前阶段：M3 完成**——登录态、项目列表、绑定、拉取（自动 `git init` + 首次提交）、推送（默认 dry-run）、三方 diff、冲突不覆盖、**后台双向同步（watch）**与**冲突解决（`overleaf_resolve`：保留本地 / 采用远端 / 合并）**，外加 **GUI 两半**：设置页（账号/项目/目录/策略/git/watch 配置）与**右侧边栏 tab**（状态、待推送、Pull/Push、后台同步开关、冲突逐条解决、日志尾巴、SSE 实时刷新）。下一阶段 M4c 打磨（见[设计文档](docs/design.md) §16 里程碑）。

## 安装

```bash
# 本地开发：直接 link 进 profile（改代码后重启 DSH 生效）
dsh plugin --profile desktop add link:C:/code/dsh-overleaf-sync
```

或手工两步（与 CLI 等价）：

1. profile 的 `package.json` 里加依赖 `"dsh-overleaf-sync": "link:C:/code/dsh-overleaf-sync"`，并把 `dsh-overleaf-sync` 追加进 `dsh.profile.bundles`；
2. 在 profile 目录 `pnpm install`，然后重启 DSH。

插件默认配置在 `cordis.patch.yml`，可在 profile 的 `cordis.patch.yml` 里用同 id 覆盖（整体替换，不深合并）。

## 快速开始

1. 浏览器登录 Overleaf → DevTools → 复制 `Cookie`（`overleaf_session2=…`）与页面里 `<meta name="ol-csrfToken">` 的值；
2. `overleaf_login` 粘贴这两个值（**插件不收密码**）；
3. `overleaf_projects` 找到项目 id；
4. `overleaf_link`（不传 `localRoot` 时拉到 `~/Overleaf/<项目名>`）；
5. `overleaf_pull` —— 下载全部文档，并自动 `git init` + 首次提交；
6. 改本地文件 → `overleaf_diff` 确认只动了本地 → `overleaf_push`（先 dry-run，再 `dryRun: false` 真正写远端）。

## 工具

| 工具 | 作用 | 是否写 |
|---|---|---|
| `overleaf_status` | 登录态、绑定项目、文件数、git 状态、watch 状态 | 否 |
| `overleaf_login` | 保存 cookie/CSRF（或 `clear` 清除） | 本地凭据 |
| `overleaf_logout` | 删除本地凭据 | 本地凭据 |
| `overleaf_projects` | 列出可见项目（id / 名称 / 最后修改） | 否 |
| `overleaf_link` | 绑定项目 ↔ 本地目录，写 `link.json` | 本地 |
| `overleaf_pull` | 远端 → 本地；首次成功自动建 git 仓库 | 本地文件 |
| `overleaf_push` | 本地 → 远端（**默认 dry-run**） | 远端 |
| `overleaf_diff` | 三方对比 local / baseline / remote，可选 unified diff | 否 |
| `overleaf_watch` | 后台双向同步：`on`/`off`/`status`（同一项目同一账号只允许一条活动连接） | 两端 |
| `overleaf_conflicts` | 列出未解决的冲突条目（含 `.local`/`.remote` 副本位置） | 否 |
| `overleaf_resolve` | 解决冲突：`keep_local` / `keep_remote` / `merge`（可 `all: true`） | 两端 |

## 默认行为

| 项 | 默认 | 配置键 |
|---|---|---|
| 拉取目录 | `~/Overleaf/<项目名>` | `localRootPattern` |
| 拉取后建 Git 仓库 | **是**（已在上层仓库内则复用，不嵌套） | `git.autoInit` |
| 写远端 | 工具默认 dry-run，必须显式 `dryRun: false` | — |
| 冲突 | **永不静默覆盖**：本地保留，远端写 `foo.remote-<ts>.tex` | `defaultStrategy` |
| 后台 watch | **关**（可随时在侧边栏或 `overleaf_watch` 开启；`autoStart` 为真时插件加载即启动） | `watch.autoStart` |

## 自建服务器（Overleaf CE / Server Pro）

`baseUrl` 默认 `https://www.overleaf.com`，可在设置页「高级」区块或 `overleaf_login` 的 `baseUrl` 参数里改成任意实例：

- **Cookie 原样透传**：不解析 cookie 名，`overleaf_session2`（官方/新版 CE）与 `sharelatex.sid`（老版 CE）都能用；CSRF 从页面 `ol-csrfToken` meta 读取。
- **协议回退**：socket.io 握手先试 `joinProject` v1，被拒后自动切 v2（`?projectId=…`）。
- **子路径部署**：`https://host/overleaf/` 这类实例，HTTP 请求跟随 baseUrl 子路径，socket.io 自动用 `/overleaf/socket.io/`。
- **老协议自建实例**：不少自建实例仍是 socket.io **0.9**（如 `latex.cstcloud.cn`）。插件会自动探测（`/socket.io/1/` 握手）并切到零依赖的 0.9 客户端 （`src/transport/legacy.ts`，含同 sid 重试、自动 join、心跳），上层 API 不变。注意这类服务器**同一项目同一账号只允许一个 socket**：浏览器里开着该项目时，插件的 pull/push 会等它释放，错误信息会提示先关掉标签页。
- **已知限制**：登录仍需从浏览器复制 Cookie（不实现账号密码/SSO 登录）；socket.io 2.x/3.x 中间代（既能连 4 又不像 0.9 的自定义分支）未单独适配。

## 状态与安全

- 凭据、`link.json`、`state.json`、冲突快照、审计流水都在 `~/.dsh/overleaf-sync/`，**不写进项目目录**（避免被同步上云）。
- 日志只打 `overleaf_session2=***`，不打印 cookie 原文。
- `overleaf_login` 的 schema 里没有密码字段，模型拿不到也不需要密码。

## 开发

```bash
npm run build      # tsc → lib/
npm run typecheck  # tsc --noEmit
npm test           # node --test "test/**/*.test.mjs"（189 个：transport / core / service / plugin / server / client）
```

测试用假 transport 跑真实文件系统与 git：`test/service/pull.test.mjs` 覆盖拉取、幂等拉取、推送 OT、冲突保留四条主路径。

## GUI（M4a 设置页 + M4b 侧边栏，已完成）

浏览器半侧（`lib/client.js`）是**薄壳**——所有文件与网络操作仍在 Node 半侧，客户端只渲染与触发：

- **设置页**（Settings → Overleaf 同步）：粘贴 Cookie/CSRF（只写凭据中心、不回显）、选项目、校验并绑定本地目录、冲突策略与 git/watch 开关；显式「保存修改」，写回 profile 配置条目，409 冲突不覆盖。
- **右侧边栏 tab**（Overleaf 同步）：项目名与文件数、待推送、冲突数；**后台同步开关卡**（运行中/未启用、已打开文档数、最近事件时间、错误提示）；拉取（本地有改动会二次确认）与推送（预演 / 真实推送，真实推送要确认）；本地目录路径一键复制；**冲突逐条解决**（保留本地 / 采用远端 / 合并）；最近活动（journal 尾巴）。数据来自 `/overleaf/api/*`，并用 `GET /overleaf/events`（SSE）实时失效重拉，断流自动降级为 15s 轮询。

Host 半侧注册 `/overleaf/api/*`（`status`、`login`、`logout`、`projects`、`validate-path`、`link`、`pull`、
`push`、`diff`、`conflicts`、`journal`、`settings.describe`、`settings.update`）与 `GET /overleaf/events`，
统一 JSON 信封（SSE 除外）、同源校验、错误码 → HTTP 状态映射；设置页写入走 DSH Settings 服务（乐观锁
revision，冲突回 `E_SETTINGS_CONFLICT`，绝不覆盖别处的修改）。没有 `webServer`/`settings` 的宿主退化成纯工具插件，
没有右侧栏的 Shell 只少一个 tab，设置页照常工作。

细节与 API 契约见[设计文档 §14](docs/design.md)、[Host↔浏览器接口契约](docs/m4a-api-contract.md) 与[客户端 UI 契约调研](docs/client-ui-notes.md)。

## 文档

- [设计文档](docs/design.md) —— 背景、参考实现剖析、插件形态、架构、同步算法、协议事实、配置、状态机、**GUI（设置页与侧边栏）**、失败模式、测试策略、里程碑。
- [插件 API 笔记](docs/dsh-plugin-api-notes.md) —— 从已安装 DSH 包实测出的 Cordis 插件契约（带出处行号）。
- [客户端 UI 契约调研](docs/client-ui-notes.md) —— `settings.section`、右侧边栏两段式注册、Host 通信、tsdown 构建与 7 个坑（带出处行号）。
