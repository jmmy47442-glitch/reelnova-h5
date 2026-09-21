# Cloudflare Container FFmpeg 转码

本项目不使用 Cloudflare Stream。原片通过 Media Worker 分片写入私有 R2，Nuxt 在 D1 创建 `transcode_jobs`，Media Worker 通过私有 Service Binding 调用 Transcode Worker。Transcode Worker 创建可恢复的 Workflow，由 Workflow 调用 Cloudflare Container 中的 FFmpeg。

## 组件

- `wrangler.media.toml`：上传、R2 校验、签名播放，通过 `TRANSCODE_SERVICE` 调用转码服务。
- `wrangler.transcode.toml`：Workflow、Container Durable Object 和 R2 binding。
- `workers/transcode-worker.mjs`：转码任务幂等启动、Workflow 重试、HMAC 回调。
- `containers/transcoder/`：FFmpeg + ffprobe + tigrisfs 镜像。R2 以 FUSE 挂载，分片直接写入不可变 build 前缀，所有输出落盘后才发布 `ready.json`。

## 前置条件

- Cloudflare Workers Paid 计划，帐号已可使用 Containers 和 Workflows。
- 本地安装并启动 Docker，Wrangler 部署时会构建 `linux/amd64` 镜像。
- 为 `reelnova-media-private` 创建专用 R2 S3 API Token，仅授予该 bucket 对象读写权限。不要使用帐号级 Global API Key。

## Secrets

`MEDIA_WORKER_SECRET` 必须与 Media Worker 和 Nuxt 环境中的值完全一致，用于 Container Workflow 回调签名。

```bash
npx wrangler secret put MEDIA_WORKER_SECRET --config wrangler.transcode.toml
npx wrangler secret put R2_ACCOUNT_ID --config wrangler.transcode.toml
npx wrangler secret put R2_ACCESS_KEY_ID --config wrangler.transcode.toml
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.transcode.toml
```

## 部署顺序

```bash
# 1. 先部署 Workflow + Container，创建 Service Binding 目标
npm run deploy:transcoder

# 2. 再部署 Media Worker
npm run deploy:media-worker

# 3. 最后部署 Nuxt/Pages 应用
npm run build:cloudflare
```

部署后在管理后台“站点与支付”检查 `R2 连接` 和 `FFmpeg Container` 都为“已连通”。新建 Container 首次部署后可能需要数分钟完成资源预置。

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

`wrangler deploy --dry-run --config wrangler.transcode.toml` 也会构建镜像，因此同样需要 Docker daemon。
