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
| GET | `/api/me/library` | Purchases and watch progress for the signed-in user |
| POST | `/api/orders` | Create a local order and PayPal order |
| GET | `/api/orders/{orderNo}` | Poll server-confirmed order state |
| POST | `/api/orders/restore` | Start verified purchase restoration |

## Admin endpoints

| Scope | Endpoints |
| --- | --- |
| Authentication | `POST /api/admin/auth/login`, `GET /api/admin/auth/session`, `POST /api/admin/auth/logout` |
| Administrators | `GET/POST /api/admin/administrators`, `PATCH /api/admin/administrators/{id}` (super administrator only) |
| Dashboard | `GET /api/admin/dashboard` (Cloudflare D1 only) |
| Pending items | `GET /api/admin/pending-items` (orders and PayPal Webhook failures from Cloudflare D1) |
| Series | `GET/POST /admin/api/series`, `PUT /admin/api/series/{id}`, `POST /admin/api/series/{id}/publish` |
| Episodes | `GET/POST /admin/api/series/{id}/episodes`, `POST /admin/api/uploads/multipart` |
| Home sections | `GET/PUT /admin/api/home-sections`, `PUT /admin/api/home-sections/sort` |
| Orders | `GET /api/admin/orders`, `POST /api/admin/orders/{orderNo}/verify` |
| Users | `GET /api/admin/users`, `PATCH /api/admin/users/{userId}`, `POST /api/admin/users/{userId}/release-device`, `POST /api/admin/users/{userId}/entitlements` |
| Reconciliation | `GET /api/admin/reconciliation` |
| PayPal | `GET/PUT /admin/api/paypal/config`, `GET /admin/api/paypal/webhook-health` |
| Site/domain | `GET/PUT /admin/api/site-config`, `GET/POST /admin/api/domains` |
| Audit | `GET /api/admin/audit` |
| Connection health | `GET /api/admin/connection` |

Order creation must use a server-side price snapshot. Playback requests must validate the user session and entitlement every time. PayPal approval in the browser is not proof of payment; only a verified capture or webhook may issue entitlement.
