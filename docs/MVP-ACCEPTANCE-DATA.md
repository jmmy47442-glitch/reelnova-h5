# MVP acceptance data

The D1 acceptance fixture is maintained by `scripts/seed-acceptance-data.mjs`.
The normal seed is idempotent and only creates the documented `acc-*` catalogue
records. It also removes old `RN-ACCEPT-*` transaction fixtures so they cannot
appear as real customer purchases.

```bash
npm run db:seed:acceptance
npm run check:acceptance-data
```

Transaction fixtures are intentionally opt-in and must only be loaded into an
isolated acceptance database:

```bash
npm run db:seed:acceptance:transactions
ACCEPTANCE_INCLUDE_TRANSACTION_FIXTURES=true npm run check:acceptance-data
```

The fixture provides five published, playable open-movie catalogue entries, six
homepage sections, rights-cleared poster/backdrop URLs, and persisted attribution
in `series.copyright_notice`. `Big Buck Bunny: Acceptance Cut` has three ready
Cloudflare Stream episodes: episode 1 is a preview and episodes 2-3 are locked.
Sintel, Tears of Steel, Elephants Dream, and Cosmos Laundromat each have a ready
Stream episode imported from Wikimedia Commons. All five identify the applicable
Blender Foundation Creative Commons licence in D1.

When the opt-in transaction seed is used, the two labelled transaction fixtures
document both persistence states for that same title:

- `RN-ACCEPT-PAID-2026`: paid order, granted entitlement, and watch history.
- `RN-ACCEPT-REFUNDED-2026`: refunded order, completed refund request, and
  revoked entitlement.

These labelled rows make admin, history, entitlement, refresh, and refund-state
screens repeatable. They are not evidence that PayPal accepted a payment or
delivered a Webhook. Final payment acceptance must use a PayPal Sandbox buyer:

1. Sign in with a non-fixture account and play episode 1.
2. Confirm episode 2 returns `403 Entitlement required`.
3. Complete PayPal Sandbox checkout and retain the RN order number.
4. Confirm `PAYMENT.CAPTURE.COMPLETED` is recorded and the entitlement is granted.
5. Reload the site, play episode 2, and record watch history.
6. Refund the capture from the admin order page.
7. Confirm the refund Webhook marks the order refunded, revokes entitlement,
   and episode 2 again returns `403` after a fresh login.

After completing the flow, deploy the revision containing migration 0022 and the
updated Webhook handler. Resend both the successful capture event and the refund
event once from the PayPal Sandbox Webhooks dashboard, then persist a
machine-readable evidence file:

```bash
npm run db:migrate -- --apply
npm run check:acceptance-payment -- --output artifacts/paypal-sandbox-acceptance.json
```

The checker ignores `RN-ACCEPT-*` fixtures and only passes when D1 contains a
real Sandbox capture, cancellation, processed duplicate delivery, completed
refund and refund Webhook, plus the corresponding granted/revoked entitlement
states. Set `ACCEPTANCE_PAID_ORDER_NO`, `ACCEPTANCE_CANCELLED_ORDER_NO` and
`ACCEPTANCE_REFUNDED_ORDER_NO` to pin a specific test run; otherwise the newest
matching records are used. The JSON contains provider/order identifiers but no
buyer email or credentials and is written with owner-only permissions.

Production builds ignore `REELNOVA_PUBLIC_MOCK_FALLBACK` even when it is set to
`true`; a missing published D1 catalogue returns `503` instead of prototype data.

Production release readiness and Sandbox transaction acceptance are separate.
`npm run check:production` verifies that deployed `APP_BASE_URL` is actively using
Production checkout. Live secrets remain in the deployment secret store and do
not need to be duplicated into `.env`; set `PRODUCTION_ENV_FILE` only when a
release operator needs the additional local OAuth/Webhook registration audit.
The transaction fixture never claims a production-money or Sandbox payment pass.
