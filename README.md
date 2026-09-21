# reelnova-h5

## 项目基础资料

| 项目 | 内容 |
| --- | --- |
| 项目名称 | 海外短剧 H5 点播平台 |
| 产品品牌 | ReelNova |
| 正式主域名 | `iseedrama.com` |
| 正式访问地址 | `https://iseedrama.com` |
| 兼容域名 | `www.iseedrama.com`，上线后 301 跳转至主域名 |
| 管理后台域名 | `admin.iseedrama.com`，根路径进入 `/admin` |
| 媒体服务域名 | `media.iseedrama.com`，绑定 Cloudflare 媒体 Worker |
| 目标市场 | 美国，后续扩展东南亚 |
| 默认语言与结算 | 美式英语 `en-US`、美元 `USD` |
| 客服与隐私邮箱 | `support@iseedrama.com`、`privacy@iseedrama.com` |

完整的域名、回调、DNS 和上线待补参数见 [`docs/PROJECT-INFORMATION.md`](./docs/PROJECT-INFORMATION.md)。

## 本地运行

当前仓库包含 Vue 3 + Nuxt 3 用户端 H5，以及基于 Art Design Pro / Element Plus 设计规范的后台管理 UI。业务接口由 Nuxt/Nitro 提供，内容、订单、观看记录与配置存储于 Cloudflare D1。`NUXT_PUBLIC_API_BASE` 可用于指定 API 地址。

使用 `.nvmrc` 指定的 Node.js 22.22.0 和 npm 10.9.2，与 Cloudflare Pages 构建环境保持一致。

```bash
nvm use
npm ci
npm run dev
```

修改依赖时使用 npm 10.9.2 执行 `npm install`，并一起提交 `package.json` 和 `package-lock.json`。提交前执行 `npm ci` 和 `npm run build:cloudflare`；Cloudflare Pages 自动安装依赖时会校验锁文件，缺失或不匹配的条目会导致部署在构建前失败。

- 用户端：登录 `/login`，注册 `/register`，首页 `/`，探索 `/explore`，片库 `/library`，个人中心 `/profile`。用户必须注册或登录后才能进入用户端界面。
- 核心流程：详情 `/series/{slug}`，分集播放 `/watch/{slug}/{episode}`，使用后台已上架的真实短剧。
- 管理后台：概览 `/admin`，短剧 `/admin/series`，订单 `/admin/orders`，首页配置 `/admin/operations`，支付配置 `/admin/system`。
- 管理后台仅提供登录，不开放注册。所有管理员账号（包括预设超级管理员）均保存在 Cloudflare D1 `admin_accounts` 表，未连接数据库时不使用内存数据兜底。默认超级管理员为 `admin@reelnova.com` / `ReelNova@2026`；可通过 `SUPER_ADMIN_EMAIL`、`SUPER_ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 和 `ADMIN_CREDENTIAL_SECRET` 覆盖。启用 Cloudflare Access 后，服务端会验证 Access JWT 的签名和声明。
- 超级管理员可在 `/admin/administrators` 直接创建管理员，系统生成的登录密码仅在创建成功时返回一次。
- 已删除原型内容回退和虚构后台数据；数据库不可用时返回错误，保存失败不会回退到内存并报告成功。
- 用户端不显示播放数、评分、虚构在线人数。真实更新提示每 30 秒及返回首页/窗口时比较最新数据，按变化的短剧与分组计数，刷新成功后清零；请求时间戳、隐藏播放数字和观看进度变化不计入更新。Popular 按 D1 中通过授权校验的播放开始事件累计排序；播放器实际开始播放时上报，同一播放会话同一集只计一次，心跳不增加播放量。New 按更新时间排序。两个分组由系统生成，后台管理附加分区。
- 已删除未验证邮箱归属的密码重置入口及接口、无服务支撑的个性化推荐和营销邮件开关。
- MVP 验收草稿目录可通过 `npm run db:seed:acceptance` 幂等导入；后台上传兼容 MP4、封面并上架后，用 `npm run check:acceptance-data` 只读核对；该命令不会创建伪造支付或购买权益。需要验收后台订单状态时，必须在隔离环境显式运行 `npm run db:seed:acceptance:transactions`。字段、PayPal Sandbox 实测步骤见 [`docs/MVP-ACCEPTANCE-DATA.md`](./docs/MVP-ACCEPTANCE-DATA.md)。
- 封面仍指向旧自动缩略图接口、默认图或 Stream 地址时，运行 `node scripts/repair-series-posters.mjs` 只读扫描；添加 `--prepare --ffmpeg-path /path/to/ffmpeg` 提取现有视频画面并生成竖版封面、横版背景，可用 `--frame-time SERIES_ID=SECONDS` 指定取帧时间（可重复）。检查 `/tmp/reelnova-poster-repair` 中图片后，单独运行 `node scripts/repair-series-posters.mjs --apply` 上传到 R2 并更新 D1。脚本保留原地址和文件校验值，验证公开图片后才更新记录，遇到并发修改会停止；已上传的自定义图片不会被替换。Stream 视频只在提取时需要临时签名，保存后的封面不依赖 Stream。
- PayPal 与 R2 可以后开通：配置留空时 H5 会关闭结账入口、后台会禁用媒体上传，服务端不会写入失败订单或上传任务；开通后补齐 `.env.example` 对应变量并重启即可启用。
- MVP 域名使用普通 Cloudflare Custom Domains：Nuxt 绑定根域名和 `admin`，媒体 Worker 绑定 `media`，`www` 通过 Cloudflare Redirect Rule 301 到根域名。后台动态添加任意第三方备用域名需在 Cloudflare for SaaS 开通后再启用。
- 验收命令：`npm run typecheck`、`npm run build`、`npm run visual-check`；正式域名绑定后运行 `npm run check:domains` 验证 DNS、TLS 与 `www` 301。
- 接口约定见 [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md)，后台 UI 基线见 [`docs/ART-DESIGN-PRO.md`](./docs/ART-DESIGN-PRO.md)。`NUXT_PUBLIC_API_BASE` 应指向包含 `/auth`、`/admin` 和业务路由的 API 根路（本地默认为 `/api`）。
- Cloudflare D1、规范化内容模型、R2 媒体链路、播放统计与 PayPal 真实订单配置见 [`docs/CLOUDFLARE-INTEGRATION.md`](./docs/CLOUDFLARE-INTEGRATION.md)。

## 当前实现

- 用户端与管理后台：TypeScript、Vue 3、Nuxt 3、Element Plus。
- 服务端：Nuxt/Nitro API，Cloudflare D1 数据库。
- 视频：Cloudflare 私有 R2 存储兼容 MP4，媒体 Worker 校验文件并签名分发；无需 Stream 订阅。
- 上传要求：MP4、H.264 8 位视频、AAC-LC 音频；单文件不超过 20 GB，推荐 faststart 以加快首帧。提供离线 2 秒 HLS 切片工具；分片就绪后自动使用多清晰度播放，未切片视频采用流式 MP4。部署与旧视频处理见 [`docs/R2-MP4-DELIVERY.md`](./docs/R2-MP4-DELIVERY.md)。
- 支付：PayPal 订单、支付回调、权益与退款处理。

真实支付和媒体上传需要对应服务凭据，缺少配置时入口禁用。
