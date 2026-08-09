# reelnova-h5

## UI 原型运行

当前仓库包含 Vue 3 + Nuxt 3 用户端 H5，以及基于 Art Design Pro / Element Plus 设计规范的后台管理 UI。业务数据由 Nuxt mock API 提供，真实后台可通过 `NUXT_PUBLIC_API_BASE` 接入。

```bash
npm install
npm run dev
```

- 用户端：首页 `/`，探索 `/explore`，片库 `/library`，个人中心 `/profile`。
- 核心流程：详情 `/series/vows-and-vengeance`，锁片播放 `/watch/vows-and-vengeance/4`。
- 管理后台：概览 `/admin`，短剧 `/admin/series`，订单 `/admin/orders`，首页配置 `/admin/operations`，支付配置 `/admin/system`。
- 验收命令：`npm run typecheck`、`npm run build`、`npm run visual-check`。
- 接口约定见 [`docs/API-INTEGRATION.md`](./docs/API-INTEGRATION.md)，后台 UI 基线见 [`docs/ART-DESIGN-PRO.md`](./docs/ART-DESIGN-PRO.md)。
- Cloudflare D1、播放统计与 PayPal 真实订单配置见 [`docs/CLOUDFLARE-INTEGRATION.md`](./docs/CLOUDFLARE-INTEGRATION.md)。

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
