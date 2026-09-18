# R2 MP4 签名直播放

本项目不再依赖 Cloudflare Stream。后台把视频分片上传至私有 R2，Worker 校验实际文件后将分集标记为可发布。用户通过登录、免费集/购买权益、设备数量和频率检查后，获取有效期约 10 分钟的签名播放地址。每次媒体读取（包括拖动进度的 Range 请求）都校验签名；播放器会提前续签。

## 视频要求

- `.mp4`，单条 H.264 8 位视频轨 + 单条 AAC-LC 音轨。
- 普通 MP4（非 fragmented MP4），开启 faststart，使完整 moov 元数据位于文件前 16 MiB。
- 单文件不超过 20 GB，时长不超过 6 小时。
- 上传后不自动转码、不生成多清晰度。播放器固定使用上传画质；原片码率过高会增加弱网缓冲。
- 封面通过后台单独上传，不再从 Stream 获取缩略图。

可在上传前用 FFmpeg 转成兼容格式（保留原视频尺寸）：

```bash
ffmpeg -i input.mov -map 0:v:0 -map 0:a:0 -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -preset medium -c:a aac -profile:a aac_low -b:a 128k -movflags +faststart output.mp4
```

已经是兼容 H.264 + AAC-LC、只缺 faststart 的文件，可仅重新封装：

```bash
ffmpeg -i input.mp4 -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart output.mp4
```

后台浏览器会预检，Worker 再读取实际 R2 对象前 16 MiB 校验编码、时长、尺寸和 faststart，并核对上传归属及字节数。该检查不等同于逐帧解码质检，上线前仍须抽检画面和声音。校验结果缓存在私有 `validation/` 前缀下，按资源 ID 和对象 ETag 隔离。

## 部署顺序

1. 保持 R2 bucket 私有，关闭 `r2.dev` 公开访问和 bucket 公共域名。媒体域名绑定 Worker。
2. Worker 配置 `MEDIA_BUCKET` binding 和 `MEDIA_WORKER_SECRET`。`wrangler.media.toml` 的 `APP_ORIGINS` 必须包含用户端与管理端域名。保留 Cron、`APP_BASE_URL`、`PUBLIC_BASE_URL`。
3. 先部署新版 Worker，再部署 Nuxt：

   ```bash
   npm run deploy:media-worker
   npm run build:cloudflare
   ```

4. Nuxt 配置 `CLOUDFLARE_MEDIA_WORKER_URL`、`CLOUDFLARE_MEDIA_WORKER_SECRET`（与 Worker 相同）、`CLOUDFLARE_MEDIA_SIGNING_SECRET`（独立密钥），以及已有 D1 配置。
5. `/admin/system` 的“R2 连接”应显示“已连通”。这是签名请求实际访问 Worker 和 R2 binding 的结果。`npm run check:cloudflare`、`npm run check:production` 也改用该检查。

应用和 Worker 均不再需要 Stream Customer Code、Stream Webhook Secret 或 Stream API 权限。旧 Stream 回调返回 410；Worker 不再提供 Stream Token/转码接口，定时清理也不会请求 Stream。数据库保留历史 Stream 字段及转码记录以避免破坏历史迁移，无新增数据库迁移。Cloudflare API Token 若仍用于 D1 REST、域名管理或部署，应继续保留对应权限。

本次代码调整不自动取消 Cloudflare 账单订阅，也不删除远端 Stream 资源。先完成新链路与现有视频验收，再在 Cloudflare 后台处理 Stream 服务。

## 现有视频

- 已就绪且 R2 原片兼容：首次获取签名地址时完成服务端校验，随后直接播放，无需重新上传。
- 旧分集停留在处理中或处理失败：在分集管理中点击“重新校验”，从现有 R2 文件恢复，不再提交转码。
- MOV、HEVC、缺少 faststart、损坏或已无 R2 原片：转换后重新上传。不能假设所有旧 Stream 视频的原片都符合浏览器直播放要求。
- 使用独立封面上传补齐封面；旧自动缩略图接口不再访问 Stream。
- 上传完成响应丢失可重试；Cron 继续恢复 `completing` 会话和清理过期分片。格式不合格的文件进入 `failed`，需要重新导出上传。

## 验收

```bash
npm run typecheck
npm run test:media-worker
npm run test:playback-security
npm run build:cloudflare
npx wrangler deploy --dry-run --config wrangler.media.toml
```

本地启动 Nuxt 后可运行 `VISUAL_BASE_URL=http://127.0.0.1:3000 npm run check:direct-playback-ui`，使用合成 MP4 和拦截的业务 API 检查真实浏览器解码、续播、拖动和签名续期，不写入真实账号/订单/播放记录。

上线后上传兼容 MP4，检查断点续传、校验完成、后台预览、上架、免费集播放、付费集未购拒绝/已购可播、进度拖动、断点续播及超过 10 分钟的连续播放。检查 Chrome、Android 浏览器及 iPhone Safari 的画面和声音。确认网络请求不再访问 Stream。

取消 Stream 不代表零运行成本：R2 存储/请求、Worker 请求和计算仍按实际套餐计费。
