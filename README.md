# reelnova-h5
## 推荐技术选型

本项目面向美国市场，包含移动端 H5 点播页面、运营管理后台、PayPal 支付、视频转码与 HLS 分发等功能。MVP 阶段推荐使用以下技术栈：

| 层级 | 推荐语言 | 推荐技术 |
| --- | --- | --- |
| 用户端 H5 | TypeScript | vue3 + Next.js |
| 运营管理后台 | TypeScript | vue3 + Vite + Ant Design |
| 服务端 API | Java 21 | Spring Boot 3 |
| 数据库 | SQL | PostgreSQL |
| 缓存与会话 | - | Redis |
| 视频处理 | Java 调度 | FFmpeg + HLS |

### 选型说明

- 用户端要求兼容 iOS Safari、Android Chrome 和常见内嵌浏览器，同时需要支持 SEO 和分享页面，因此采用 TypeScript + Next.js。
- 用户端和运营后台统一使用 TypeScript/React，便于共享 API 类型、表单校验、国际化资源和基础组件。
- 服务端需要处理订单事务、PayPal Webhook 验签与幂等、权益发放、退款状态和审计日志，因此采用 Java + Spring Boot。
- 视频转码直接使用 FFmpeg，MVP 阶段由 Java 服务投递和调度转码任务；后续业务量增长后可再拆分独立 Worker。
- Next.js 主要承担 H5 渲染和页面服务，不作为核心支付后端；支付回调、权益校验和转码任务由 Spring Boot 服务负责。

### 备选方案

如果开发团队明显更熟悉 Vue，可将用户端替换为 `TypeScript + Vue 3 + Nuxt 3`，将运营后台替换为 `TypeScript + Vue 3 + Vite + Element Plus`；服务端选型保持不变。
