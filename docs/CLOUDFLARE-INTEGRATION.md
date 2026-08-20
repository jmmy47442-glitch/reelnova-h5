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

For a local, redacted Cloudflare check without opening the admin UI, run:

```bash
npm run check:cloudflare
```

## 1. API token

An API token is needed for local Node development, D1 initialization and automated deployment. It is not needed by the deployed application when a D1 binding named `DB` is available.

Use a custom token scoped to the ReelNova account and the `iseedrama.com` zone. Do not select every permission.

- Account / D1 / Edit
- Account / Workers Scripts / Edit
- Account / Workers R2 Storage / Edit (when media uses R2)
- Account / Stream / Edit
- Account / Cloudflare Pages / Edit (when deploying to Pages)
- Zone / Zone / Read
- Zone / DNS / Edit (only when domain automation is required)

Never use the Global API Key and never expose the token through `NUXT_PUBLIC_*`.

## 2. Create D1

Create a database named `reelnova-production` in Cloudflare Dashboard under Storage and databases / D1. Record its database ID in `CLOUDFLARE_D1_DATABASE_ID`, then initialize or upgrade it with the ordered migration runner:

```bash
npm run db:migrate -- --apply
npm run db:migrate:check
```

The runner creates `schema_migrations`, applies only the next numeric migration, and records each migration's SHA-256 checksum. A gap, renamed migration, or changed historical file stops deployment. Do not execute individual migration files in production.

For a legacy database that predates `schema_migrations`, first repair every schema gap and then adopt it once:

```bash
npm run db:migrate -- --apply --adopt-existing
```

Adoption succeeds only when every required table, column, index and trigger in `database/schema-contract.json` already exists. It does not apply or conceal missing schema changes.

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
CLOUDFLARE_STREAM_WEBHOOK_URL=https://iseedrama.com/api/media/stream-webhook
SUPER_ADMIN_EMAIL
SUPER_ADMIN_PASSWORD
SUPER_ADMIN_NAME
ADMIN_SESSION_SECRET
ADMIN_CREDENTIAL_SECRET
```

`CLOUDFLARE_MEDIA_BASE_URL` is retained for legacy R2 HLS playback. New media uses Stream tokens; `CLOUDFLARE_MEDIA_SIGNING_SECRET` still signs playback tracking authorization.
`NUXT_PUBLIC_PAYPAL_CLIENT_ID` is intentionally public and must equal `PAYPAL_CLIENT_ID`. Keep both empty until PayPal is available; setting only one leaves checkout disabled or marks the connection incomplete.
The legacy `PAYPAL_*` values remain a fallback for the initial `PAYPAL_ENVIRONMENT`. Configure both named Sandbox and Production sets to enable environment switching from `/admin/system`. The selected environment is the only payment configuration stored in D1; Client Secrets remain encrypted deployment secrets. Each order also stores its immutable PayPal environment so later Capture, verification, refunds and Webhooks keep using the correct API after a switch. The first switch attributes pre-0016 orders to the currently active environment. A switch first verifies the target OAuth credentials and is blocked while pending payments, refunds, or risk-review orders exist.
`SUPER_ADMIN_PASSWORD` initializes the preset super administrator on first use. `ADMIN_SESSION_SECRET` signs the HttpOnly admin session cookie. `ADMIN_CREDENTIAL_SECRET` encrypts the password verifier used by the low-CPU challenge login flow. Both secrets must be separate, stable, high-entropy production secrets; changing `ADMIN_CREDENTIAL_SECRET` requires resetting administrator credentials.

## 4. Deploy the private media Worker

Create the R2 bucket, then configure the Worker secrets and deploy it:

```bash
npx wrangler r2 bucket create reelnova-media-private
npx wrangler secret put MEDIA_WORKER_SECRET --config wrangler.media.toml
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID --config wrangler.media.toml
npx wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler.media.toml
npm run deploy:media-worker
```

Set `PUBLIC_BASE_URL`, `APP_BASE_URL` and `APP_ORIGINS` in `wrangler.media.toml` to the deployed Worker URL, application URL and allowed admin origins. The Worker Cron trigger runs the signed reconciliation endpoint every hour. Use the same random `MEDIA_WORKER_SECRET` as the Nuxt `CLOUDFLARE_MEDIA_WORKER_SECRET`; never expose it through `NUXT_PUBLIC_*`.

This project declares `media.iseedrama.com` as the Worker's Cloudflare custom domain. `PUBLIC_BASE_URL` and the Nuxt application's `CLOUDFLARE_MEDIA_WORKER_URL` must both use `https://media.iseedrama.com`. The allowed origins include `https://admin.iseedrama.com` so browser multipart uploads from the admin subdomain pass CORS validation.

In Cloudflare Stream, set the notification URL to:

```text
https://iseedrama.com/api/media/stream-webhook
```

Store the returned webhook signing secret in `CLOUDFLARE_STREAM_WEBHOOK_SECRET`. Copy the Stream customer code to `CLOUDFLARE_STREAM_CUSTOMER_CODE` when available; for new uploads the application can also use the HLS URL returned by Stream after the video becomes ready, so the customer code is a fallback rather than a hard requirement. The Worker keeps original objects private, exposes only a one-hour signed ingest URL to Stream, and creates every Stream video with `requireSignedURLs=true`.

The production connection check also reads `CLOUDFLARE_STREAM_WEBHOOK_URL` (defaulting to the URL above) and compares it with Cloudflare's active Stream Webhook. A configured Secret alone is not considered ready when the remote callback points at another hostname. Run `npm run check:production` before a release. In MVP mode, Cloudflare for SaaS is optional and does not block this check.

The same `CLOUDFLARE_API_TOKEN` used by the media Worker must include `Account / Stream / Edit`; otherwise R2 uploads can start, but Stream copy, status sync and signed playback token creation fail with a Cloudflare `403 Authentication error`.

Upload sessions use a client-persisted idempotency key. D1 records the R2 completion key, Stream creator key, completion parts and every external resource ID. `GET /api/admin/media/uploads/:uploadId` exposes a `completing` session for recovery; repeating the completion request is safe even when the previous response was lost. The Worker stores an ownership marker on multipart-created objects, looks up Stream videos by the stable creator key before copying, and its hourly reconciliation job aborts expired multipart uploads and removes only stale, owned R2/Stream resources that are no longer referenced by D1.

## 5. PayPal webhook

Register this production endpoint in PayPal Developer Dashboard:

```text
https://iseedrama.com/api/paypal/webhook
```

Subscribe at minimum to:

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`
- `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.COMPLETED`, `PAYMENT.REFUND.FAILED` and `PAYMENT.REFUND.CANCELLED` when available for the merchant account

Copy PayPal's Webhook ID to `PAYPAL_WEBHOOK_ID`. The server verifies every webhook with PayPal before updating an order. Duplicate events are recorded once by `event_id`; verified processing failures can be replayed from the admin connection page.

## 6. Custom domains and HTTPS

### 6.1 MVP: ordinary Custom Domains

The MVP uses only hostnames owned in the `iseedrama.com` zone and does not require Cloudflare for SaaS. Keep the SaaS feature switch disabled:

```dotenv
CLOUDFLARE_ZONE_ID=195dc8829b5b019c7d2ea29d8fe14101
CLOUDFLARE_FOR_SAAS_ENABLED=false
CLOUDFLARE_DOMAIN_CNAME_TARGET=
```

In **Workers & Pages → the Nuxt deployment → Custom domains**, bind `iseedrama.com` and `admin.iseedrama.com`. Cloudflare provisions their certificates. `admin.iseedrama.com` serves the same Nuxt deployment; the application redirects its root path to `/admin`.

Deploy the media Worker with `npm run deploy:media-worker`. `wrangler.media.toml` declares `media.iseedrama.com` as its Custom Domain.

Create a proxied `www` DNS record, then add a **Rules → Redirect Rules → Single Redirect** rule with these values:

| Setting | Value |
| --- | --- |
| Rule name | `www-to-apex` |
| Match expression | `(http.host eq "www.iseedrama.com")` |
| Target type | Dynamic |
| Target expression | `concat("https://iseedrama.com", http.request.uri.path)` |
| Status code | `301` |
| Preserve query string | Enabled |

The same rule can be created or updated idempotently with the configured Zone ID and API Token:

```bash
npm run deploy:domain-redirect
```

The token needs permission to edit zone rulesets. A token with only Zone Read and Stream access returns Cloudflare error `10000` and leaves the rule unchanged. The script only creates or updates the rule whose reference is `www-to-apex`; it preserves other rules in the phase.

The Nuxt server also has the same path-and-query-preserving `301` as a fallback. The Cloudflare Redirect Rule remains the production traffic entry and should be verified from the public edge.

After Cloudflare shows all three Custom Domains as active, run:

```bash
npm run check:domains
```

This command validates public DNS and TLS for all four hostnames, then confirms that the edge returns an exact path-and-query-preserving `301` from `www` to the apex domain.

Configure the required hostnames as follows:

| Hostname | Purpose | Target/behavior |
| --- | --- | --- |
| `iseedrama.com` | User H5 and same-origin API/Webhooks | Cloudflare Pages/Workers production application |
| `www.iseedrama.com` | Compatibility entry | Cloudflare Redirect Rule permanently redirects to `https://iseedrama.com` |
| `admin.iseedrama.com` | Operations console | Same application origin; `/` redirects to `/admin` |
| `media.iseedrama.com` | R2/Stream media Worker | Wrangler custom domain declared in `wrangler.media.toml` |

Do not add a separate `api.iseedrama.com` for the MVP. The application uses same-origin `/api`, which keeps user/admin cookies, PayPal return handling, and CORS behavior consistent.

### 6.2 Deferred: Cloudflare for SaaS

The admin page marks dynamic third-party backup-domain onboarding as **待 Cloudflare for SaaS 开通**. While `CLOUDFLARE_FOR_SAAS_ENABLED` is not `true`, the add, verify, primary-switch, redirect-toggle, settings, and delete APIs reject SaaS domain mutations with HTTP `503`.

To enable this later:

1. Contact Cloudflare Sales and obtain SSL for SaaS / Custom Hostnames quota.
2. Configure a fallback origin pointing to the current Nuxt deployment.
3. Obtain or create the shared CNAME hostname used by SaaS customer domains.
4. Set `CLOUDFLARE_DOMAIN_CNAME_TARGET` to that hostname and set `CLOUDFLARE_FOR_SAAS_ENABLED=true`.
5. Give `CLOUDFLARE_API_TOKEN` `Zone / Zone / Read` and the Custom Hostnames/SSL edit permissions required by the account plan.
6. Add the backup domain in the admin page, publish the displayed CNAME/TXT records, and wait until both Custom Hostname and SSL are `active`.
7. Only then switch the primary domain or enable the old-domain `301`.

The SaaS CNAME target is assigned for the fallback origin. It is not the public apex hostname and must not be guessed or set to `iseedrama.com` unless Cloudflare explicitly supplies that value.

## 7. Verify

The administrator session protects `/api/admin/*` by default. To add Cloudflare Access, first create an Access application covering `admin.iseedrama.com/*`, verify that authenticated requests receive `Cf-Access-Jwt-Assertion`, and then set `CLOUDFLARE_ACCESS_REQUIRED=true`. Do not enable the application-level requirement before the Access application is active, or every protected administrator API will return 401 after login.

Build the Cloudflare target and open the connection diagnostics page:

```bash
npm run build:cloudflare
npm run check:domains
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
