# ReelNova API integration

The UI reads all business data through `composables/useContentApi.ts`. Local Nuxt server routes provide mock responses for development. Set `NUXT_PUBLIC_API_BASE` to the Spring Boot gateway URL to connect a real backend without changing page components.

## Response envelope

```json
{
  "code": 0,
  "message": "ok",
  "requestId": "bcb48f3d-...",
  "data": {}
}
```

Non-2xx responses should keep the same `code`, `message`, and `requestId` fields. Secrets, raw object-storage paths, and payment credentials must never be returned.

## H5 endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create a viewer account and signed session |
| POST | `/api/auth/login` | Authenticate a viewer and create a signed session |
| GET | `/api/auth/session` | Read the current signed viewer session |
| POST | `/api/auth/logout` | Clear the current viewer session |
| GET | `/api/home` | Configured home sections and series cards |
| GET | `/api/explore` | Search, filter and sort series |
| GET | `/api/series/{slug}` | Series metadata, pricing and episode entitlement states |
| GET | `/api/playback?seriesId=&episodeNo=` | Server-authorized short-lived HLS URL |
| POST | `/api/events/playback` | Compatibility endpoint for authorized playback events |
| GET/POST | `/api/me/watch-history` | Read history or persist an authorized start, heartbeat or completion snapshot |
| GET | `/api/me/library` | Purchases and account-level watch progress for the signed-in user |
| DELETE | `/api/me/watch-history` | Clear account watch history without deleting playback analytics |
| POST | `/api/orders` | Create or reuse an idempotent local and PayPal order |
| GET | `/api/orders/{orderNo}` | Poll server-confirmed order state |
| POST | `/api/orders/restore` | Restore a paid order matched to the signed-in account |
| POST | `/api/paypal/capture` | Capture an approved PayPal order and issue entitlement |
| GET/PATCH | `/api/me/settings` | Read or persist account-level language and privacy preferences |
| POST | `/api/me/data-export` | Create an audited export of profile, activity, orders, entitlements, and refunds |
| DELETE | `/api/me/account` | Confirm and execute account anonymization and activity deletion |

## Admin endpoints

| Scope | Endpoints |
| --- | --- |
| Authentication | `POST /api/admin/auth/login`, `GET /api/admin/auth/session`, `POST /api/admin/auth/logout` |
| Administrators | `GET/POST /api/admin/administrators`, `PATCH /api/admin/administrators/{id}` (super administrator only) |
| Dashboard | `GET /api/admin/dashboard` (Cloudflare D1 only) |
| Pending items | `GET /api/admin/pending-items` (orders and PayPal Webhook failures from Cloudflare D1) |
| Series | `GET/POST /api/admin/series`, `PUT/DELETE /api/admin/series/{id}`, `PATCH /api/admin/series/{id}/status`, `POST /api/admin/series/{id}/duplicate` |
| Episodes | `GET /api/admin/series/{id}/episodes`, `POST /api/admin/series/{id}/episodes/uploads`, `PATCH /api/admin/media/uploads/{id}/progress`, `POST /api/admin/media/uploads/{id}/complete`, `POST /api/admin/media/{assetId}/retry`, `GET /api/admin/media/{assetId}/preview` |
| Home sections | `GET/PUT /api/admin/home-config` |
| Orders | `GET /api/admin/orders`, `POST /api/admin/orders/{orderNo}/verify`, `GET/POST /api/admin/orders/{orderNo}/refund` (refund mutation requires super administrator) |
| Users | `GET /api/admin/users`, `GET/PATCH /api/admin/users/{userId}`, `POST /api/admin/users/{userId}/release-device`, `POST /api/admin/users/{userId}/entitlements` |
| Reconciliation | `GET /api/admin/reconciliation` |
| Taxonomy | `GET/PUT /api/admin/taxonomy` |
| PayPal | `GET /api/admin/connection`, `PATCH /api/admin/paypal/environment`, `POST /api/admin/paypal/webhooks/{eventId}/retry` (mutations require super administrator; credentials remain Cloudflare Secrets and are never returned) |
| Domains | `GET /api/admin/domains` always reports the current domain mode. SaaS mutation endpoints (`PUT /settings`, `POST`, `POST /{id}/verify`, `PATCH /{id}`, `DELETE /{id}`) return `503` until `CLOUDFLARE_FOR_SAAS_ENABLED=true`; API Token remains a deployment secret. |
| Site/domain | MVP hostnames use ordinary Cloudflare Custom Domains and a Redirect Rule. After Cloudflare for SaaS is enabled, the same admin endpoints manage Custom Hostnames and SSL state for third-party backup domains. |
| Audit | `GET /api/admin/audit` |
| Connection health | `GET /api/admin/connection` |

Episode uploads use 10 MiB R2 multipart chunks. The browser may resume an unexpired upload session, while R2 and Stream credentials remain in the media Worker. A series cannot be published until every non-deleted episode has a `ready` media asset. Cloudflare Stream reports asynchronous progress through `POST /api/media/stream-webhook`; episode list polling also reconciles missed callbacks.

Order creation must use a server-side price snapshot. Playback requests must validate the user session and entitlement every time. PayPal approval in the browser is not proof of payment; only a verified capture or webhook may issue entitlement.

Paid-order and refunded-order transitions drive payment entitlements through D1 triggers. Applying `0019_entitlement_lifecycle.sql` makes the order update and its entitlement grant/revocation one atomic database statement. Repeated capture, webhook, refresh, and login requests read the same persisted entitlement, while a completed refund immediately removes access unless another paid order for the same account and series remains valid.

Playback clients send a `start` when video playback begins, a `heartbeat` every 15 seconds and on pause/seek/page exit, and `complete` when the episode ends. Each write appends the authorized event to `playback_events` and updates one account-level snapshot in `watch_history`. Resume playback, Library and Profile all read that snapshot; clearing history removes only the snapshot so aggregate playback reporting remains intact.

`POST /api/orders` accepts an optional client request `idempotencyKey`, while the server also derives a stable purchase key from the authenticated user and series. A granted entitlement returns `status: "paid"` and `entitlementStatus: "granted"`; an existing `pending` or `processing` checkout returns its original order and PayPal approval details. The database permits only one open checkout per user and series, and the captured price version, amount and activity fields are immutable.

When PayPal credentials are absent, `POST /api/orders` and refund operations return `503` with code `PAYPAL_NOT_CONFIGURED` before writing payment state. `GET /api/paypal/config` exposes only the active environment's public browser Client ID. Environment changes validate the target credentials against PayPal and are rejected while unresolved payments or refunds exist. When the R2 media Worker is absent, upload creation returns `503` with code `MEDIA_PIPELINE_NOT_CONFIGURED` before creating episode or media rows. Frontend controls use the admin connection status and public PayPal Client ID to remain disabled until configuration is complete.
