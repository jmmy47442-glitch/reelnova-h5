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

## UI 原型运行

当前仓库包含 Vue 3 + Nuxt 3 用户端 H5，以及基于 Art Design Pro / Element Plus 设计规范的后台管理 UI。业务数据由 Nuxt mock API 提供，真实后台可通过 `NUXT_PUBLIC_API_BASE` 接入。

```bash
npm install
npm run dev
```

- 用户端：登录 `/login`，注册 `/register`，首页 `/`，探索 `/explore`，片库 `/library`，个人中心 `/profile`。用户必须注册或登录后才能进入用户端界面。
- 核心流程：详情 `/series/vows-and-vengeance`，锁片播放 `/watch/vows-and-vengeance/4`。
- 管理后台：概览 `/admin`，短剧 `/admin/series`，订单 `/admin/orders`，首页配置 `/admin/operations`，支付配置 `/admin/system`。
- 管理后台仅提供登录，不开放注册。所有管理员账号（包括开发环境预设超级管理员）均保存在 Cloudflare D1 `admin_accounts` 表，未连接数据库时不使用内存数据兜底。为兼容现有 D1 数据，开发环境仍使用历史预设账号 `admin@reelnova.com` / `ReelNova@2026`；新生产部署应通过 `SUPER_ADMIN_EMAIL=admin@iseedrama.com`、`SUPER_ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 和 `ADMIN_CREDENTIAL_SECRET` 覆盖默认值。已有生产账号需由超级管理员确认后迁移，不能仅靠修改默认值替换。
- 超级管理员可在 `/admin/administrators` 直接创建管理员，系统生成的登录密码仅在创建成功时返回一次。
- D1 尚无已上架短剧时，用户端会自动展示原型测试内容，后台仍使用真实 D1 接口。D1 出现真实已上架内容后会自动切换，也可用 `REELNOVA_PUBLIC_MOCK_FALLBACK=false` 关闭测试内容。
- PayPal 与 R2/Stream 可以后开通：配置留空时 H5 会关闭结账入口、后台会禁用媒体上传，服务端不会写入失败订单或上传任务；开通后补齐 `.env.example` 对应变量并重启即可启用。
- 验收命令：`npm run typecheck`、`npm run build`、`npm run visual-check`。
- 接口约定见 [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md)，后台 UI 基线见 [`docs/ART-DESIGN-PRO.md`](./docs/ART-DESIGN-PRO.md)。`NUXT_PUBLIC_API_BASE` 应指向包含 `/auth`、`/admin` 和业务路由的 API 根路（本地默认为 `/api`）。
- Cloudflare D1、规范化内容模型、R2/Stream 媒体链路、播放统计与 PayPal 真实订单配置见 [`docs/CLOUDFLARE-INTEGRATION.md`](./docs/CLOUDFLARE-INTEGRATION.md)。

## 推荐技术选型

本项目面向美国市场，包含移动端 H5 点播页面、运营管理后台、PayPal 支付、视频转码与 HLS 分发等功能。MVP 阶段推荐使用以下技术栈：

| 层级 | 推荐语言 | 推荐技术 |
| --- | --- | --- |
| 用户端 H5 | TypeScript | Vue 3 + Nuxt 3（Node.js） |
| 运营管理后台 | TypeScript | Vue 3 + Element Plus（Art Design Pro） |
| 服务端 API | Java 21 | Spring Boot 3 |
| 数据库 | SQL | PostgreSQL |
| 缓存与会话 | - | Redis |
| 视频处理 | Java 调度 | FFmpeg + HLS |

### 选型说明

- 用户端要求兼容 iOS Safari、Android Chrome 和常见内嵌浏览器，同时需要支持 SEO 和分享页面，因此采用 TypeScript + Vue 3 + Nuxt 3。
- 用户端和运营后台统一使用 TypeScript/Vue 3，便于共享 API 类型、表单校验、国际化资源和基础组件。
- 服务端需要处理订单事务、PayPal Webhook 验签与幂等、权益发放、退款状态和审计日志，因此采用 Java + Spring Boot。
- 视频转码直接使用 FFmpeg，MVP 阶段由 Java 服务投递和调度转码任务；后续业务量增长后可再拆分独立 Worker。
- Nuxt 3 主要承担 H5 渲染、页面服务和开发期 mock API，不作为核心支付后端；支付回调、权益校验和转码任务由 Spring Boot 服务负责。
