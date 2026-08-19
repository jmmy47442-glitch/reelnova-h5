# 海外短剧 H5 点播平台项目资料

> 更新日期：2026-08-19  
> 本文档是品牌、域名、业务入口和上线参数的统一记录。密钥不得写入本文档或提交到 Git。

## 1. 基础资料

| 字段 | 已确认内容 |
| --- | --- |
| 项目名称 | 海外短剧 H5 点播平台 |
| 产品品牌 | ReelNova |
| 产品形态 | 面向美国用户的移动端竖屏短剧点播 H5 与运营管理后台 |
| 正式主域名 | `iseedrama.com` |
| 正式站点 | `https://iseedrama.com` |
| 兼容入口 | `https://www.iseedrama.com`，301 跳转到主域名并保留路径与查询参数 |
| 管理后台 | `https://admin.iseedrama.com`；根路径进入 `/admin` |
| 媒体服务 | `https://media.iseedrama.com`；Cloudflare Worker 自定义域名 |
| 默认语言 | 美式英语 `en-US` |
| 默认币种 | 美元 `USD` |
| 支付渠道 | PayPal Checkout |
| 目标市场 | 美国；东南亚为后续扩展方向 |
| 客服邮箱 | `support@iseedrama.com` |
| 隐私邮箱 | `privacy@iseedrama.com` |
| 生产管理员邮箱 | `admin@iseedrama.com`，待邮箱开通和现有账号迁移 |

产品品牌沿用 ReelNova，正式域名使用 `iseedrama.com`。除非后续另行确认品牌更名，不应仅因域名变化批量修改 ReelNova 的产品名称、订单前缀或数据库资源名。

## 2. 当前接入状态

| 检查项 | 2026-08-19 实测结果 |
| --- | --- |
| Cloudflare Zone | 已存在且为 `active` |
| Cloudflare Zone ID | `195dc8829b5b019c7d2ea29d8fe14101` |
| API Token 基础验证 | 通过 |
| D1 与 Stream API 访问 | 通过 |
| DNS/Custom Hostnames API | 当前 Token 返回 403，需补相应 Zone 权限 |
| `iseedrama.com` DNS | 暂无可解析记录 |
| 正式站 HTTPS | 因 DNS 未解析，暂不可访问 |
| 二级域名代码配置 | `admin`、`media` 已配置 |
| 二级域名 DNS/证书 | `media` 已发布；`admin` 待主站项目权限 |
| CNAME 接入目标 | 尚未配置 |
| Stream Webhook Secret | 尚未配置 |

## 3. 正式业务入口

| 用途 | 地址 |
| --- | --- |
| 用户端 | `https://iseedrama.com/` |
| 管理后台 | `https://admin.iseedrama.com/admin`（访问根路径会自动进入 `/admin`） |
| 媒体 Worker | `https://media.iseedrama.com` |
| API 根路径 | `https://iseedrama.com/api` |
| PayPal Webhook | `https://iseedrama.com/api/paypal/webhook` |
| PayPal return URL | `https://iseedrama.com/api/paypal/return` |
| Cloudflare Stream Webhook | `https://iseedrama.com/api/media/stream-webhook` |

PayPal Developer Dashboard、Cloudflare Stream 和所有来源白名单必须使用 HTTPS 正式地址。不要把 `localhost`、预览域名或媒体 Worker 地址配置为生产支付回调。

## 4. 域名与 DNS 策略

- `iseedrama.com` 是唯一主域名，分享链接、回调地址和站内绝对链接均以此域名为准。
- `www.iseedrama.com` 只作为兼容入口；HTTPS 证书正常后启用永久跳转。
- `admin.iseedrama.com` 运行同一 Nuxt 应用，仅承载运营后台入口；后台 API 仍使用同源 `/api/admin`。
- `media.iseedrama.com` 绑定媒体 Worker，用于分片上传、私有原片摄取和媒体任务接口。
- MVP 不单独配置 `api.iseedrama.com`，避免跨域 Cookie、CORS 和 PayPal return URL 增加额外复杂度。
- DNS 托管、HTTPS、WAF 和自定义域名自动化统一由 Cloudflare 管理。
- 主域名切换前必须同步检查 PayPal Webhook、Stream Webhook、媒体 Worker CORS、Cloudflare Access 和缓存规则。
- `CLOUDFLARE_DOMAIN_CNAME_TARGET` 是 Cloudflare for SaaS 分配的接入目标，不等同于公开主域名，不能凭空填写。

## 5. 尚需运维或业务方提供

| 参数 | 保存位置 | 状态 |
| --- | --- | --- |
| Cloudflare Zone ID | 部署环境或后台域名接入设置 | 已确认并写入配置模板 |
| Cloudflare for SaaS CNAME target | 部署环境或后台域名接入设置 | 待 Cloudflare 分配 |
| Cloudflare API Token | 部署 Secret | 待确认权限后配置 |
| Pages/Workers 正式部署地址 | Cloudflare 项目 | 待部署 |
| `admin.iseedrama.com` Pages/Workers 自定义域名 | Cloudflare 项目 | 代码已适配，待绑定和签发证书 |
| `media.iseedrama.com` Worker 自定义域名 | `wrangler.media.toml` | 已发布，Worker 版本 `2dba0524-6574-4ae7-96a7-099f536843ac` |
| 媒体 Worker 正式地址与 Secret | Cloudflare Worker Secret | 待部署/配置 |
| Stream customer code 与 Webhook secret | 部署 Secret | 待开通/配置 |
| PayPal Sandbox/Production Client ID、Secret、Webhook ID | 部署 Secret | 待商户后台确认 |
| 公司主体、注册地址、税务与 PayPal 商户信息 | 合规资料 | 待业务方提供 |
| Terms、Privacy、Refund Policy 最终法律文本 | 法务资料 | 待审核 |
| 备用域名与域名切换审批人 | 发布流程 | 待业务方确认 |

以上项目无法通过域名本身推导。未取得真实值前应保持为空，不能使用示例值冒充生产配置。

## 6. 上线核对

- 根域名与 `www` 均能通过 HTTPS 访问，`www` 返回 301 并保留原路径和查询参数。
- `admin.iseedrama.com` 根路径进入 `/admin`，登录和 `/api/admin/*` 均通过 Cloudflare Access。
- `media.iseedrama.com` 可访问且只允许清单中的 H5/后台来源跨域调用。
- PayPal 生产 Webhook 已注册并完成官方签名验证，支付成功后只发放一次权益。
- Stream Webhook 可更新转码状态，已购用户获取短时签名播放地址。
- 媒体 Worker 的 `APP_BASE_URL` 为 `https://iseedrama.com`，允许源包含根域名和 `www`。
- `support@iseedrama.com` 与 `privacy@iseedrama.com` 已创建并完成收发测试。
- 生产环境已覆盖默认管理员密码和会话密钥，并开启 Cloudflare Access。
- 关闭或严格限制测试内容回退，确认真实内容可播放后再开启生产收款。
