# R2 HLS / MP4 签名播放

本项目不再依赖 Cloudflare Stream。后台把视频分片上传至私有 R2，Worker 校验实际文件后将分集标记为可发布。用户通过登录、免费集/购买权益、设备数量和频率检查后，获取有效期约 10 分钟的签名播放地址。每次媒体读取（包括拖动进度的 Range 请求）都校验签名；播放器会提前续签。

## 视频要求

- `.mp4`，单条 H.264 8 位视频轨 + 单条 AAC-LC 音轨。
- 普通 MP4（非 fragmented MP4），开启 faststart，使完整 moov 元数据位于文件前 16 MiB。
- 单文件不超过 20 GB，时长不超过 6 小时。
- 普通上传不自动转码。可使用下方离线工具生成低码率移动版；省流量、蜂窝或低速网络优先选择已就绪的移动版，没有合格移动版时播放原片。这一 MP4 回退模式在起播/续签时选源；生成下述 HLS 包后改为逐片自适应码率。
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

## 鉴权后的边缘缓存

- `MEDIA_EDGE_CACHE="true"` 启用 Cloudflare Cache API。每次请求先解密并校验签名有效期，再查缓存。签名中绑定对象 key、ETag、大小；命中时无需 R2 HEAD/GET。旧签名仍兼容，通过 R2 HEAD 取得元数据。
- 缓存键按媒体域名、对象 key、ETag、大小和块偏移隔离，使用 SHA-256 摘要及 `v2` 内部命名空间。签名、有效期和不影响内容的查询参数不参与缓存键：不同有效授权、重复打开和续签可共享同一版本的视频块。HLS 使用包含 assetId、原片版本、buildId、清晰度和文件名的不可变对象路径隔离；更新内容会使用新的缓存键。
- Cache API 不支持直接 `put` 一个 `206`。内部按 1 MiB 对齐，播放分支收到数据就转发；独立缓存分支完整读取且校验块长度后，以 `200` 写入缓存。不会等待整个 1 MiB 下载完成才返回首字节，Range 仍精确返回 `206`。支持普通范围、开放结尾、尾部范围及 `HEAD`；无效/多重 Range 返回 `416`。
- 只有内部块使用 `public, max-age=..., s-maxage=...`，TTL 为 24 小时，不再随首个授权的短期签名一起过期；缓存可能被边缘节点提前淘汰，命中仍须先通过当前请求的签名校验。对浏览器的媒体响应使用 `private, no-store`，避免浏览器或外层 CDN 绕过 Worker 鉴权；不要给 `/original/*` 或 `/hls/*` 配置强制缓存规则。
- 缓存异常回退 R2；不缓存 403、404、502、截断块等失败结果。首块读取失败返回不缓存的 502；响应开始后遇到 R2 读取失败会终止媒体流，不能再修改已发送的状态码。
- 每次请求最多处理 16 个缓存块，后续数据单次 R2 流式读取，限制 Worker 子请求数量和内存。`X-Media-Cache: HIT/MISS` 表示首块结果，后续块可能混合命中；`BYPASS` 表示缓存关闭/不可用。
- Cache API 仅在当前 Cloudflare 节点生效，不提供自动跨节点复制/分层缓存。本地测试不能代表线上命中率。
- 资源路径应保持不可变。删除/替换 R2 原片后，已缓存的旧签名数据最多可继续播放到签名过期；ETag 条件读取会拒绝从 R2 拼入新版本。如需立即撤销，需要额外的撤销检查或清缓存机制。

## 下一集预热

当前集已播放至少 5 秒、剩余不超过 30 秒、缓冲足够且下一集可观看时，浏览器请求下一集授权，沿用服务端登录、权益、设备和限流检查，使用独立的下一集 session。预加载不会提交播放开始事件或观看历史。

授权端让 Worker 在 `ctx.waitUntil` 中预热首块和末块（最多各 1 MiB，兼容旧片尾部 moov）；客户端另发一个最多 512 KiB 的 Range 请求，预热用户实际所在的节点。客户端不把字节存进持久缓存，切集会在内存中一次性移交同一签名地址和会话，利用边缘缓存加速后续媒体请求。浏览器仍负责正常的视频缓冲。

省流量、蜂窝/弱网、后台页面跳过预加载；当前集卡顿、隐藏或离开页面会取消客户端预加载。可选预加载最多执行一次且 10 秒超时；失败不影响当前播放。Worker 已启动的 MP4 后台预热最多两块，客户端取消不会撤回它。HLS 则预热主清单、最低码率的子清单、初始化段和第一个媒体段，最多 4 个文件；客户端也只请求这 4 个文件，每批最多 2 个并发，减少串行往返等待。隐藏页面或当前集卡顿时中止在途请求，并停止后续批次；弱网仍跳过预加载。

## 低码率移动版

先安装 FFmpeg，再针对实际原片生成 H.264 + AAC-LC、faststart、宽度不超过 480 像素、视频目标峰值 900 kbps、音频 96 kbps 的版本。使用当前 R2 原片的 **原始 ETag**（不是文件名或 asset ID）：

```bash
npm run media:prepare-mobile -- --input /path/source.mp4 --output /path/mobile.mp4 --asset-id media_UUID --source-etag ORIGINAL_R2_ETAG
```

工具默认只生成本地 MP4 和对应 `.json` 上传清单；不覆盖已存在的输出，也不改原片。检查效果后，在相同命令添加 `--upload` 将文件上传到私有 bucket（需 Wrangler 凭据），可用 `--bucket` 指定 bucket。对象键为 `variants/{assetId}/{encodeURIComponent(originalEtag)}/mobile.mp4`。原片更新后旧移动版不会被选中，须针对新 ETag 重新生成；旧 variants 的清理由运维单独处理。

Worker 仅从上述确定路径选取比原片更小且通过编码/faststart 校验的文件。服务端接受 `profile=mobile` 或 `Save-Data: on`；客户端根据 Network Information API 的 `saveData`、`type=cellular`、`effectiveType` 或 `downlink<2` 选择。浏览器不提供网络信息时默认原片。移动版标签显示 `Data saver`。不通过 `Accept` 猜测 HEVC 支持，继续使用目前跨浏览器已验证的 H.264。

## 2 秒 HLS 分片与自适应码率

`MEDIA_HLS="true"` 时，播放授权优先寻找当前原片 ETag 对应的已发布 HLS 包；没有、尚未上传完成、格式错误或版本不匹配时继续使用 MP4。该流程使用私有 R2 和自己的 Worker，不需要重新启用 Cloudflare Stream。

安装 FFmpeg 和 FFprobe 后运行（也可通过 `FFMPEG_PATH`、`FFPROBE_PATH` 指定可执行文件）：

```bash
npm run media:prepare-hls -- --input /path/source.mp4 --output /path/new-hls-directory --asset-id media_UUID --source-etag ORIGINAL_R2_ETAG
```

工具输出 360P / 480P / 720P / 1080P 四档（不会放大低分辨率原片）、H.264 Main + AAC-LC、30 fps、对齐的 2 秒 GOP 和独立 fMP4 分片。360P / 480P 保留 500 / 900 kbps 的省流量档；720P / 1080P 使用 CRF 20、medium 编码预设，码率上限分别为 4500 / 8000 kbps，使复杂画面保留更多纹理，简单画面按需使用码率。音频 96 kbps；主清单带宽取实际分片峰值，避免用码率上限高估带宽需求。新包标记为 `h264-hq1080-v2`，重建时不会复用旧低码率包。必须使用新的输出目录。先抽检画音；正式生成并发布时添加 `--upload`（可指定 `--bucket`），该操作会上传输出文件：

- 媒体对象位于 `hls/{assetId}/{encodeURIComponent(sourceEtag)}/{buildId}/`。
- 所有文件成功上传后，最后写入 `hls/{assetId}/{encodeURIComponent(sourceEtag)}/ready.json`，此时新授权才启用 HLS。
- 每次 buildId 独立，未完成的上传不会覆盖已有可播放包，也不破坏旧签名。上传失败后使用新的输出目录重跑；旧包和失败上传的清理由运维另行安排。
- 原片更新 ETag 后必须重新切片；不会把另一版本的片段拼入当前视频。

HLS 授权同时提供经格式校验的私有原片签名地址，播放器可选择 Original 播放原片；原片无法校验或格式不兼容时仅提供 HLS。原片和切片使用相同有效期并独立鉴权。Cloudflare Stream 资源只能选择其实际生成的档位，不提供不存在的原片入口。

已发布的 720P 包不会自动获得 1080P。先部署支持四档和原片地址的 Worker 与应用，再使用 `npm run media:migrate-hls -- --rebuild-hls` 从 R2 原片重新生成并发布（会转码和上传）；不加该参数仍跳过已有 HLS。原片短边不足 1080 时不生成 1080P，保留 Original 供完整分辨率播放。

播放器默认 Auto，在 hls.js 下从最低码率首片起播，根据下载吞吐量和缓冲情况自动升降画质；持续补充约 30 秒前向缓冲，无需等缓冲全部填满才播放。恢复/拖动直接从目标时间附近的分片开始。支持原生 HLS 的浏览器由浏览器管理码率。未准备 HLS 的旧视频也受益于此次 MP4 首字节流式转发修复，但不会凭空获得多清晰度。

手选 HLS 清晰度时保留当前播放片段，在后续片段切换，避免清空可播放缓冲。如果固定画质的视频片段下载时间超过其播放时长（至少 3 秒），且可播放缓冲仅剩 2 秒以内，播放器会恢复 Auto 并提示用户，取消慢请求并从当前进度改取低码率片段，保留已有缓冲；已下载至少 90% 的片段会继续完成。恢复后暂时限制在发生卡顿档位以下，连续稳定播放约 30 秒后解除，避免小分片造成带宽高估而立即升回高码率。暂停预加载、正常速度下载、有足够缓冲或已处于最低档时不会触发；独立音频请求也不会干扰检测。此保护不适用于直接播放原始 MP4。

Worker 对清单、初始化段和每个媒体段都先校验签名，再访问缓存；对象未命中时立即流式返回 R2 数据，独立缓存分支完成后才入缓存。每段不超过 8 MiB。鉴权后按不可变对象路径共享缓存，多个用户和续签可复用同一版本的清单及分片；缓存仅在当前边缘节点生效。设置 `MEDIA_HLS="false"` 并部署 Worker 可停止为新授权签发 HLS，已签发 HLS 链接继续有效到过期。

真实浏览器检查：先生成至少 12 秒、含多个清晰度的测试包，启动本地 Nuxt 后运行：

```bash
HLS_FIXTURE_DIR=/path/new-hls-directory VISUAL_BASE_URL=http://127.0.0.1:3107 npm run check:hls-playback-ui
HLS_FIXTURE_DIR=/path/new-hls-directory VISUAL_BASE_URL=http://127.0.0.1:3107 node scripts/check-hls-recovery-ui.mjs
# 使用至少 12 秒的真实 1080P 测试包及对应 MP4，检查解码分辨率与原画切换：
HLS_FIXTURE_DIR=/path/1080p-hls HLS_ORIGINAL_FIXTURE=/path/source-1080p.mp4 node scripts/check-hls-quality-ui.mjs
```

该检查用合成资源和拦截的业务 API 验证首片低码率、自动升档、连续解码、下一集预热/授权复用和拖动，不写入线上播放记录。生产包仍需在真实网络及 iPhone Safari 验收，不能用本地结果承诺秒开或完全不卡顿。

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

- 已就绪且 R2 原片为兼容 H.264 + AAC-LC MP4：首次获取签名地址时完成服务端校验，随后直接播放，无需重新上传。旧片的 moov 元数据可以位于文件尾；Worker 按元数据偏移读取并跳过视频数据，最多读取 16 MiB、32 次，浏览器通过 Range 请求播放。播放校验缓存与新上传的 faststart 校验缓存隔离。
- 旧分集停留在处理中或处理失败：在分集管理中点击“重新校验”，从现有 R2 文件恢复，不再提交转码。
- MOV、HEVC、损坏或已无 R2 原片：转换后重新上传。新上传仍要求 faststart；旧片仅缺少 faststart 时可以直接播放，建议后续重新封装以改善首帧速度。不能假设所有旧 Stream 视频的原片都符合浏览器直播放要求。
- 使用独立封面上传补齐封面；旧自动缩略图接口不再访问 Stream。
- 上传完成响应丢失可重试；Cron 继续恢复 `completing` 会话和清理过期分片。格式不合格的文件进入 `failed`，需要重新导出上传。

## 验收

```bash
npm run typecheck
npm run test:media-worker
npm run test:playback-prefetch
npm run test:playback-security
npm run build:cloudflare
npx wrangler deploy --dry-run --config wrangler.media.toml
```

本地启动 Nuxt 后可运行 `VISUAL_BASE_URL=http://127.0.0.1:3000 npm run check:direct-playback-ui`，使用合成 MP4 和拦截的业务 API 检查真实浏览器解码、续播、拖动和签名续期，不写入真实账号/订单/播放记录。

上线后上传兼容 MP4，检查断点续传、校验完成、后台预览、上架、免费集播放、付费集未购拒绝/已购可播、进度拖动、断点续播及超过 10 分钟的连续播放。检查 Chrome、Android 浏览器及 iPhone Safari 的画面和声音。确认网络请求不再访问 Stream。

缓存验收：在同一边缘节点，用两个不同的有效签名 URL 请求同一对象版本及范围，确认 `X-Media-Cache` 从 `MISS` 变成 `HIT`，字节和 `Content-Range` 一致；更新原片 ETag 或 HLS buildId 后应为 `MISS`。旧签名过期后必须返回 403，新有效签名仍能命中已有缓存。切集预加载复用授权和会话，未购买下一集不能请求媒体。故障时可设置 `MEDIA_EDGE_CACHE="false"` 并重新部署 Worker 回退到 R2 直读。

取消 Stream 不代表零运行成本：R2 存储/请求、Worker 请求和计算仍按实际套餐计费。
