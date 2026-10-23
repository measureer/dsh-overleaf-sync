# 发布流程

两条通道，互不阻塞。

## 1. GitHub（已可用）

```bash
gh release create v0.1.0 .tmp/dsh-overleaf-sync-0.1.0.tgz \
  --title "v0.1.0 — 首次发布" --notes-file .tmp/release-notes.md
```

打 tag 前记得 `pnpm pack` 出新 tgz；`gh release create` 会自动建 tag 并上传附件。

## 2. npm

一次性的凭据准备（账号需未处于限制状态、且 2FA 策略为 auth-and-writes 时必须开 Bypass 2FA）：

1. https://www.npmjs.com/settings/~/tokens → Generate New Token → **Granular Access Token**
2. Permissions: **Read and write**；Packages: 选 `dsh-overleaf-sync` 或 *All packages*
3. 勾选 **Bypass 2FA**（否则 CLI 发布会要求 6 位动态码，恢复码不能代替）
4. 复制 `npm_...`，写到一次性 npmrc（**不要提交**）：

```bash
umask 077
printf 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=%s\n' 'npm_xxx' > .tmp/npmrc
NPM_CONFIG_USERCONFIG="$(pwd -W)/.tmp/npmrc" pnpm publish --no-git-checks --access public
rm -f .tmp/npmrc
```

确认：

```bash
curl -s https://registry.npmjs.org/dsh-overleaf-sync | head -c 200
```

### CI 发布（推荐后续用）

仓库已带 `.github/workflows/publish.yml`：推 `v*` tag 即在 GitHub Actions 里构建 + 测 + 发布。需要仓库 secret `NPM_TOKEN`（就是上面那个带 Bypass 2FA 的 token）：

```bash
gh secret set NPM_TOKEN --repo measureer/dsh-overleaf-sync
```

然后 `git tag v0.1.1 && git push --tags` 即自动发布。
