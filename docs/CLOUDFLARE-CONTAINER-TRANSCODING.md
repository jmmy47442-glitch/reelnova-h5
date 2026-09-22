# Cloudflare Container FFmpeg 转码

> 当前生产环境使用 Workers 免费版，`MEDIA_TRANSCODE_ENABLED=false`，仅接收兼容的 H.264（8 位）+ AAC-LC MP4。本文保留为将来升级 Workers Paid 后启用自动转码的可选方案，不属于当前上传播放链路的部署前置条件。

本项目不使用 Cloudflare Stream。原片通过 Media Worker 分片写入私有 R2，Nuxt 在 D1 创建 `transcode_jobs`，Media Worker 通过私有 Service Binding 调用 Transcode Worker。Transcode Worker 创建可恢复的 Workflow，由 Workflow 调用 Cloudflare Container 中的 FFmpeg。

## 组件

- `wrangler.media.toml`：上传、R2 校验、签名播放，通过 `TRANSCODE_SERVICE` 调用转码服务。
- `wrangler.transcode.toml`：Workflow、Container Durable Object 和 R2 binding。
- `workers/transcode-worker.mjs`：转码任务幂等启动、Workflow 重试、HMAC 回调。
- `containers/transcoder/`：FFmpeg + ffprobe + tigrisfs 镜像。R2 以 FUSE 挂载，分片直接写入不可变 build 前缀，所有输出落盘后才发布 `ready.json`。

## 前置条件

- Cloudflare Workers Paid 计划，帐号已可使用 Containers 和 Workflows。
- 甲方的 Cloudflare 账号已开通 Workers Paid、Containers 和 Workflows。
- 由甲方指定的部署机或 CI Runner 安装并启动 Docker；Wrangler 会在该部署环境构建 `linux/amd64` 镜像。开发人员本机不需要连接甲方生产账号。
- 为 `reelnova-media-private` 创建专用 R2 S3 API Token，仅授予该 bucket 对象读写权限。不要使用帐号级 Global API Key。
- 部署用 Cloudflare API Token 除原有 Workers、Workflows、R2 权限外，还需要当前账号的 **Containers → Edit** 权限。可在个人资料的 API Tokens 页面编辑原 Token；Containers API 返回 403 时先检查这项权限和账号范围。

## Secrets

`MEDIA_WORKER_SECRET` 必须与 Media Worker 和 Nuxt 环境中的值完全一致，用于 Container Workflow 回调签名。

```bash
npx wrangler secret put MEDIA_WORKER_SECRET --config wrangler.transcode.toml
npx wrangler secret put R2_ACCOUNT_ID --config wrangler.transcode.toml
npx wrangler secret put R2_ACCESS_KEY_ID --config wrangler.transcode.toml
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.transcode.toml
```

## 部署顺序

以下命令应由甲方授权的部署人员或 CI/CD 执行，并使用甲方 Cloudflare API Token。项目交付本身不包含甲方账号登录、R2 数据迁移或生产环境发布。

```bash
# 1. 先部署 Workflow + Container，创建 Service Binding 目标
npm run deploy:transcoder

# 2. 再部署 Media Worker
npm run deploy:media-worker

# 3. 最后部署 Nuxt/Pages 应用
npm run build:cloudflare
```

Nuxt 应用建议在 Cloudflare Dashboard 的 **Workers & Pages** 中连接代码仓库部署：

- Build command：`npm run build:cloudflare`
- Build output directory：`dist`
- Node.js：使用仓库 `.nvmrc` 的 Node 22.22.0
- 绑定 D1 数据库，变量名必须是 `DB`
- 配置应用所需的 PayPal、管理员、播放签名和媒体 Worker 环境变量

如果甲方使用 CI 发布 Pages，CI 只负责构建并触发 Pages 部署；D1 binding、Secrets 和 Custom Domains 仍在甲方 Cloudflare 项目中配置。

部署后运行 `npx wrangler containers list`，确认转码 Container 应用已创建并绑定 `MediaTranscodeContainer`。只有 Worker/Durable Object binding 存在，并不代表已部署 Container 应用；缺少应用时真实任务会报 `There is no container application assigned to this Durable Object namespace`。新建 Container 首次部署后可能需要数分钟完成资源预置。

管理后台的连接检查会验证 R2 和 Workflow 资源，但完整转码可用性仍需下方真实上传测试验证，不能仅凭连接检查通过判断。

甲方需要提供或自行配置：Cloudflare Account ID、R2 bucket、D1 数据库、部署 API Token、R2 S3 API Token，以及应用域名对应的 DNS/Worker 路由。生产 Secret 只应写入甲方 Cloudflare Secrets，不要提交到代码仓库或交付包。

## 转码规则

- 输入：MP4、M4V、MOV、MKV、WebM、AVI、MPEG，最大 20 GB、最长 6 小时，必须有视频和音频轨。
- 输出：H.264 Main 8-bit + AAC-LC，2 秒 fMP4 HLS，最高 1080P。
- Container 规格：`standard-3`（2 vCPU / 8 GiB / 16 GB 临时磁盘），最多 4 个实例。原片通过 FUSE 读取，HLS 分片直接写入 R2，不要求临时盘容纳完整原片或成品。可在 `wrangler.transcode.toml` 调整，但并发越高费用越高。
- 转码中断由 Workflow 自动重试；最终失败会保留错误原因，后台可点击重试。

## 验证

```bash
npm run check:transcoder
npm run test:media-worker
npm run typecheck
```

`wrangler deploy --dry-run --config wrangler.transcode.toml` 也会构建镜像，因此应在甲方部署机或 CI Runner 执行；若仅需检查 Worker 配置，可使用 `--containers-rollout=none` 跳过镜像构建。

`--containers-rollout=none` 不会补建缺失的 Container 应用，不可替代首次完整部署。

真实链路检查（会创建隔离测试素材，成功后精确清理，保留管理员审计记录）：

```bash
# 前端上传逻辑和真实 R2，测试单分片与多分片，使用内存测试数据库
node --env-file=.env scripts/check-upload-live.mjs

# 真实 D1、R2、Workflow、FFmpeg、生产回调和 HLS 文件
node --env-file=.env scripts/check-upload-transcode-live.mjs
# 若上次基础设施故障，恢复输出的临时剧目 ID，不重复上传原片
node --env-file=.env scripts/check-upload-transcode-live.mjs --resume upload-check-UUID

# 真实浏览器和正式后台 API：从选择文件到预览解码播放
# 先通过本地环境设置 UPLOAD_CHECK_ADMIN_EMAIL / UPLOAD_CHECK_ADMIN_PASSWORD
node --env-file=.env scripts/check-upload-production-ui.mjs
```

转码测试失败会保留测试剧目和原片便于恢复。浏览器测试使用独立草稿，不上架，不修改业务剧目；未完成上传时同样保留现场。
