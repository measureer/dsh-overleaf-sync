# dsh-overleaf-sync

DSH（DeepSeek Harness）插件：把本地 LaTeX 文件夹与 Overleaf 项目双向同步，让 Agent 直接 `pull` / `push` / `diff` 你的论文。

思路参照 [measureer/overleaf-sync](https://github.com/measureer/overleaf-sync)（VS Code 插件）：不走 Git，而是复用 Overleaf 编辑器自己的协作通道（Socket.IO + OT），因此不需要付费的 Git 桥接。

**当前阶段：M2 可运行**——登录态、项目列表、绑定、拉取（自动 `git init` + 首次提交）、推送（默认 dry-run）、三方 diff、冲突不覆盖。后台 watch、`resolve` 工具与 GUI（设置页/侧边栏）仍在路线图上（见[设计文档](docs/design.md) §16 里程碑）。

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

## 默认行为

| 项 | 默认 | 配置键 |
|---|---|---|
| 拉取目录 | `~/Overleaf/<项目名>` | `localRootPattern` |
| 拉取后建 Git 仓库 | **是**（已在上层仓库内则复用，不嵌套） | `git.autoInit` |
| 写远端 | 工具默认 dry-run，必须显式 `dryRun: false` | — |
| 冲突 | **永不静默覆盖**：本地保留，远端写 `foo.remote-<ts>.tex` | `defaultStrategy` |
| 后台 watch | **关**（未实现，M3） | `watch.autoStart` |

## 状态与安全

- 凭据、`link.json`、`state.json`、冲突快照、审计流水都在 `~/.dsh/overleaf-sync/`，**不写进项目目录**（避免被同步上云）。
- 日志只打 `overleaf_session2=***`，不打印 cookie 原文。
- `overleaf_login` 的 schema 里没有密码字段，模型拿不到也不需要密码。

## 开发

```bash
npm run build      # tsc → lib/
npm run typecheck  # tsc --noEmit
npm test           # node --test 'test/**/*.test.mjs'（92 个：transport 51 + core 34 + service 4 + plugin 3）
```

测试用假 transport 跑真实文件系统与 git：`test/service/pull.test.mjs` 覆盖拉取、幂等拉取、推送 OT、冲突保留四条主路径。

## GUI（设计阶段，M4a/M4b）

浏览器半侧（`lib/client.js`）分两块，都是**薄壳**——所有文件与网络操作仍在 Node 半侧，客户端只渲染与触发：

- **设置页**（Settings → Overleaf 同步）：粘贴 Cookie/CSRF（只写凭据中心、不回显）、选项目、校验并绑定本地目录、冲突策略与 git/watch 开关；显式「保存修改」，写回 profile 配置条目，409 冲突不覆盖。
- **右侧边栏 tab**（Overleaf）：连接/同步状态、待推改动、Pull / Push(dry-run) / 打开目录、冲突列表、日志尾巴；SSE 实时刷新，断线降级轮询。

细节与 API 契约见[设计文档 §14](docs/design.md) 与[客户端 UI 契约调研](docs/client-ui-notes.md)。

## 文档

- [设计文档](docs/design.md) —— 背景、参考实现剖析、插件形态、架构、同步算法、协议事实、配置、状态机、**GUI（设置页与侧边栏）**、失败模式、测试策略、里程碑。
- [插件 API 笔记](docs/dsh-plugin-api-notes.md) —— 从已安装 DSH 包实测出的 Cordis 插件契约（带出处行号）。
- [客户端 UI 契约调研](docs/client-ui-notes.md) —— `settings.section`、右侧边栏两段式注册、Host 通信、tsdown 构建与 7 个坑（带出处行号）。
