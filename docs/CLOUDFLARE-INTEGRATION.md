# Cloudflare production data integration

The admin dashboard and administrator accounts never fall back to sample or in-memory data. When Cloudflare D1 is unavailable, dashboard, administrators, orders, reconciliation and audit logs return an explicit connection error.

## Data ownership

| Data | Source of truth | Counting rule |
| --- | --- | --- |
| Plays | Cloudflare D1 `playback_events` | One authorized `start` per session, series and episode |
| Orders | Cloudflare D1 `orders` | Created server-side before calling PayPal |
| Revenue | Verified PayPal capture | Only `status = paid`; browser approval is not payment proof |
| Entitlements | Cloudflare D1 `entitlements` | Granted only after amount and currency match the order snapshot |
| User accounts | Cloudflare D1 `users` | One row per `user_id`; profile and login credentials share one source of truth |
| Manual entitlements | Cloudflare D1 `manual_entitlements` | Admin grants are separate from payment orders and do not affect revenue |
| Administrator accounts | Cloudflare D1 `admin_accounts` | Login, account status and administrator management share one durable source of truth |
| Audit logs | Cloudflare D1 `admin_audit_logs` | Actor, source IP, target and change details for administrative actions |
| Reconciliation | Cloudflare D1 aggregation | Paid amount minus PayPal fee and refunds |
| Series and episodes | Cloudflare D1 normalized content tables | `series`, `episodes`, taxonomy associations and immutable version snapshots |
| Original media | Private Cloudflare R2 bucket | Multipart source uploads; no public bucket URL |
| Playback media | Cloudflare Stream | Private adaptive HLS authorized with short-lived Stream tokens |

Cloudflare Web Analytics request counts are not used as play counts. Page requests, bots, reloads and media segment requests do not represent a user starting an episode.

R2 is private object storage for original videos, not the application database. D1 remains the database for accounts, content metadata, orders, entitlements and media job state.

## Before PayPal and R2 are provisioned

Keep the PayPal and media variables in `.env` empty. The application deliberately remains in a partial-service state:

- Catalog, account and content metadata continue to use D1.
- H5 shows checkout as unavailable and does not call the order API.
- Direct order/refund API calls return `503` before creating or changing payment records.
- Admin content metadata remains editable, while original-video upload and transcoding controls are disabled.
- `/admin/system` reports each missing configuration item as `待配置` instead of treating it as a failed connection.

No temporary PayPal or R2 mock credentials are required. After provisioning, fill the variables below, restart/redeploy the Nuxt application, deploy the media Worker, and re-run the checks on `/admin/system`.

## 1. API token

An API token is needed for local Node development, D1 initialization and automated deployment. It is not needed by the deployed application when a D1 binding named `DB` is available.

Use a custom token scoped to the ReelNova account and domain. Do not select every permission.

- Account / D1 / Edit
- Account / Workers Scripts / Edit
- Account / Workers R2 Storage / Edit (when media uses R2)
- Account / Stream / Edit
- Account / Cloudflare Pages / Edit (when deploying to Pages)
- Zone / Zone / Read
- Zone / DNS / Edit (only when domain automation is required)

Never use the Global API Key and never expose the token through `NUXT_PUBLIC_*`.

## 2. Create D1

Create a database named `reelnova-production` in Cloudflare Dashboard under Storage and databases / D1. Record its database ID, then initialize it:

```bash
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0001_reelnova_core.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0002_users.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0003_admin_accounts.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0004_admin_audit_logs.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0005_home_config.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0006_user_accounts.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0007_merge_user_accounts.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0008_order_idempotency.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0009_refunds.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0010_normalized_content_media.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0011_refund_lifecycle.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0012_checkout_deduplication.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0013_watch_history.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0014_account_privacy.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0015_admin_rbac.sql
npx wrangler d1 execute reelnova-production --remote --file=./migrations/0016_paypal_environment.sql
```

已有数据库按尚未执行的编号顺序补齐迁移。`0010` 会把旧 `home_config` 中的 `managed-series` 和 `taxonomy` JSON 拆到规范化表；旧分集没有真实媒体资源，因此迁移后必须上传原片并完成 Stream 转码才可重新上架。`0012` 会保留每个用户同剧中最适合续付的一笔订单，将其余历史待支付订单标记为已取消，然后增加并发唯一约束和价格/活动快照字段。

For Cloudflare Pages or Workers, add a D1 binding with variable name `DB`. For local Node deployment, set the REST fallback variables shown in `.env.example`:

```dotenv
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_D1_DATABASE_ID=
CLOUDFLARE_API_TOKEN=
```

## 3. Configure encrypted secrets

Configure these values in Cloudflare Settings / Variables and Secrets. Mark secrets as encrypted:

```text
PAYPAL_CLIENT_ID
PAYPAL_SECRET
PAYPAL_WEBHOOK_ID
PAYPAL_ENVIRONMENT=production
NUXT_PUBLIC_PAYPAL_CLIENT_ID
PAYPAL_SANDBOX_CLIENT_ID
PAYPAL_SANDBOX_SECRET
PAYPAL_SANDBOX_WEBHOOK_ID
NUXT_PUBLIC_PAYPAL_SANDBOX_CLIENT_ID
PAYPAL_PRODUCTION_CLIENT_ID
PAYPAL_PRODUCTION_SECRET
PAYPAL_PRODUCTION_WEBHOOK_ID
NUXT_PUBLIC_PAYPAL_PRODUCTION_CLIENT_ID
CLOUDFLARE_MEDIA_BASE_URL
CLOUDFLARE_MEDIA_SIGNING_SECRET
CLOUDFLARE_MEDIA_WORKER_URL
CLOUDFLARE_MEDIA_WORKER_SECRET
CLOUDFLARE_STREAM_CUSTOMER_CODE
CLOUDFLARE_STREAM_WEBHOOK_SECRET
SUPER_ADMIN_EMAIL
SUPER_ADMIN_PASSWORD
SUPER_ADMIN_NAME
ADMIN_SESSION_SECRET
```

`CLOUDFLARE_MEDIA_BASE_URL` is retained for legacy R2 HLS playback. New media uses Stream tokens; `CLOUDFLARE_MEDIA_SIGNING_SECRET` still signs playback tracking authorization.
`NUXT_PUBLIC_PAYPAL_CLIENT_ID` is intentionally public and must equal `PAYPAL_CLIENT_ID`. Keep both empty until PayPal is available; setting only one leaves checkout disabled or marks the connection incomplete.
The legacy `PAYPAL_*` values remain a fallback for the initial `PAYPAL_ENVIRONMENT`. Configure both named Sandbox and Production sets to enable environment switching from `/admin/system`. The selected environment is the only payment configuration stored in D1; Client Secrets remain encrypted deployment secrets. Each order also stores its immutable PayPal environment so later Capture, verification, refunds and Webhooks keep using the correct API after a switch. The first switch attributes pre-0016 orders to the currently active environment. A switch first verifies the target OAuth credentials and is blocked while pending payments, refunds, or risk-review orders exist.
`SUPER_ADMIN_PASSWORD` initializes the preset super administrator on first use. `ADMIN_SESSION_SECRET` signs the HttpOnly admin session cookie and must be a separate high-entropy production secret.

## 4. Deploy the private media Worker

Create the R2 bucket, then configure the Worker secrets and deploy it:

```bash
npx wrangler r2 bucket create reelnova-media-private
npx wrangler secret put MEDIA_WORKER_SECRET --config wrangler.media.toml
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID --config wrangler.media.toml
npx wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler.media.toml
npm run deploy:media-worker
```

Set `PUBLIC_BASE_URL` and `APP_ORIGINS` in `wrangler.media.toml` to the deployed Worker URL and allowed admin origins. Use the same random `MEDIA_WORKER_SECRET` as the Nuxt `CLOUDFLARE_MEDIA_WORKER_SECRET`; never expose it through `NUXT_PUBLIC_*`.

In Cloudflare Stream, set the notification URL to:

```text
https://YOUR_DOMAIN/api/media/stream-webhook
```

Store the returned webhook signing secret in `CLOUDFLARE_STREAM_WEBHOOK_SECRET`, and copy the Stream customer code to `CLOUDFLARE_STREAM_CUSTOMER_CODE`. The Worker keeps original objects private, exposes only a one-hour signed ingest URL to Stream, and creates every Stream video with `requireSignedURLs=true`.

## 5. PayPal webhook

Register this production endpoint in PayPal Developer Dashboard:

```text
https://YOUR_DOMAIN/api/paypal/webhook
```

Subscribe at minimum to:

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`
- `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.COMPLETED`, `PAYMENT.REFUND.FAILED` and `PAYMENT.REFUND.CANCELLED` when available for the merchant account

Copy PayPal's Webhook ID to `PAYPAL_WEBHOOK_ID`. The server verifies every webhook with PayPal before updating an order. Duplicate events are recorded once by `event_id`; verified processing failures can be replayed from the admin connection page.

## 6. Custom domains and HTTPS

Enable Cloudflare for SaaS on the zone that fronts the application and configure its fallback origin. Add these encrypted/runtime values:

```dotenv
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_DOMAIN_CNAME_TARGET=customers.example.com
```

The API token also needs `Zone / Zone / Read` and `Zone / SSL and Certificates / Edit` for Custom Hostnames. `CLOUDFLARE_API_TOKEN` must remain a deployment secret. Super administrators can maintain the non-secret Zone ID and CNAME target from **域名管理 → 接入设置**; saved values take precedence over the environment-variable fallbacks above. `/admin/domains` creates the Custom Hostname before saving the local record, which starts DV certificate issuance. Point the requested hostname to the configured CNAME target, add any TXT validation records shown by Cloudflare, then use **同步状态** until the route and certificate are active.

Only an active hostname with healthy CNAME and HTTPS can become primary or enable redirect. Requests arriving on an enabled old hostname receive an application-level `301` to the current primary hostname while preserving path and query. Removing a backup domain also removes its Cloudflare Custom Hostname and certificate.

## 7. Verify

Protect `/api/admin/*` with a Cloudflare Access application. In production the server requires the `Cf-Access-Jwt-Assertion` header that Access adds after validating the user. Set `CLOUDFLARE_ACCESS_REQUIRED=false` only for local development.

Build the Cloudflare target and open the connection diagnostics page:

```bash
npm run build:cloudflare
```

Visit `/admin/system`. D1, PayPal and media delivery are checked independently. Then perform one sandbox purchase and confirm:

1. A pending order is inserted before PayPal approval.
2. Capture changes the order to paid.
3. Exactly one entitlement is granted.
4. The order appears in `/admin/orders`.
5. Starting an authorized episode increments the D1 playback count once for that session.
6. Heartbeats update `watch_history`, and a second device resumes the same episode at the stored second.
7. Clearing watch history empties Library/Profile progress without removing `playback_events` analytics.
8. A stopped multipart upload resumes from locally recorded completed parts.
7. A ready Stream callback updates the episode to `ready`, generates a thumbnail, and enables publish preview.

The admin user page reads `GET /api/admin/users` from D1, the administrator page reads `GET /api/admin/administrators`, and the audit page reads `GET /api/admin/audit`. Run all migrations in numeric order before opening these pages; otherwise the UI will show the explicit database migration error state. Registration creates the `users` row, and authenticated playback or order activity refreshes its country, device and last-seen fields. Verified PayPal captures update order payer details and the user's country without replacing the login email. Administrator credentials and account state use `admin_accounts`; sessions are signed HttpOnly cookies and are revalidated against that table on every protected request.
