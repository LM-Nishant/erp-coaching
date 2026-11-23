# Payment gateways

Institutes take fees online through **Paytm**, **Razorpay** or **Cashfree** with their own merchant accounts, and the
platform takes SaaS subscription payments the same way with its account. Gateways are set up in the app, not in
`.env`: an admin enters the account's keys, and nothing else is needed to go live. `PAYMENT_GATEWAY` stays `mock`.

The **mock** gateway simulates payments without moving money. It is the default for development, tests and E2E, and
production refuses it: it can't be enabled, mock configurations saved earlier are ignored at checkout, and its
simulated completion and webhook routes answer 404.

- [Payment modes and states](#payment-modes-and-states)
- [Whose account takes the money](#whose-account-takes-the-money)
- [Setting up a gateway](#setting-up-a-gateway)
- [Paytm](#paytm)
- [Razorpay](#razorpay)
- [Cashfree](#cashfree)
- [Webhooks](#webhooks)
- [Checkout on the web and in the apps](#checkout-on-the-web-and-in-the-apps)
- [Reconciliation and idempotency](#reconciliation-and-idempotency)
- [Refunds](#refunds)
- [Testing in sandbox mode](#testing-in-sandbox-mode)
- [Not yet verified with real accounts](#not-yet-verified-with-real-accounts)

## Payment modes and states

| Mode               | How it's recorded                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Online             | The payer pays in the gateway's checkout. Only the server's check with the gateway marks it paid        |
| Cash               | Recorded by staff                                                                                       |
| UPI, bank transfer | Paid straight to the institute's UPI ID or bank account; staff record it with the transaction reference |
| Cheque             | Recorded by staff with the cheque number, cheque date and bank                                          |

A fee payment is `pending` until the gateway's outcome is known, then `successful` (receipt issued, ledger posted) or
`failed`. Staff can cancel a pending payment, or reverse an unrefunded offline one such as a bounced cheque: both end
`cancelled`. Refunds make it `partially_refunded` or `refunded`. A refund is `pending` while the gateway works on it,
then `processed` or `failed`. SaaS subscription payments are `pending`, `success` or `failed`.

Nothing the browser or app reports marks a payment paid: the checkout's success callback, the gateway's redirect and
the payer's return only make the server ask the gateway. A payment is posted from a signed webhook or the server's own
status check, and money that arrives for a payment cancelled in the meantime is still posted.

Each online payment keeps the gateway's order and payment IDs, and each refund the gateway's refund ID, so they can be
matched in the vendor's dashboard:

| Reference                       | Fees                                                        | SaaS subscriptions |
| ------------------------------- | ----------------------------------------------------------- | ------------------ |
| Order sent to Paytm or Cashfree | `12-345_a1b2c3`: institute 12, payment 345, a random suffix | `saas_345_a1b2c3`  |
| Razorpay receipt                | `12-345`; Razorpay's own order ID is `order_…`              | `saas_345`         |
| Refund reference                | `rf12x678x1a2b3c4d`: institute 12, refund 678, a key hash   | No gateway refunds |

## Whose account takes the money

- **Institute fees** go to the institute's own account, set up by its admin in **Fee settings → Gateways**. With more
  than one gateway enabled, the payer chooses under **Pay with**; **Default for online payments** is preselected.
- **SaaS subscriptions** go to the platform's account, set up by the Super Admin in **Integrations → Payment
  gateways** with **Use for SaaS subscription payments**.
- **Platform fallback:** with **Offer to institutes without their own fee gateway**, an institute with no enabled
  gateway of its own takes fees through the platform's account. Once the institute enables its own gateway, new
  payments use it, and payments already taken through the platform stay serviceable.

The platform account's webhook URL is the SaaS one, so Razorpay and Paytm can't send it events about fee payments
taken through the fallback: those are confirmed when the payer returns and by [reconciliation](#reconciliation-and-idempotency).
Cashfree payments carry their own notification URL, so they get webhooks either way.

## Setting up a gateway

1. Create the merchant account with the vendor and finish their onboarding (KYC, website and app details). Test keys
   are available straight away; live keys follow approval.
2. Make sure `API_PUBLIC_URL` is the API's public `https://` address: webhook, notification and return URLs are built
   from it, and the vendors expect `https://` URLs.
3. In **Fee settings → Gateways** (institutes) or **Integrations → Payment gateways** (Super Admin), add the gateway
   and enter its keys, listed in each vendor's section below.
4. Choose the mode: **Test (sandbox)** or **Live (production)** for institutes, the **Sandbox (test) mode** switch for
   the platform. New gateways start in test mode. Use the matching keys: test keys only work in test mode.
5. Save, then press **Test saved keys** (institutes) or **Test connection** (platform). The test makes a read-only or
   never-completed call, described in each vendor's section, and charges nothing.
6. Copy the webhook URL shown on the gateway and add it in the vendor's dashboard ([webhooks](#webhooks)).
7. Make sure **Enabled** is on, then make a small test payment and a refund before switching to live mode.

Keys are stored encrypted with `ENCRYPTION_KEY` ([secrets](../deployment.md#secrets)) and are never shown again or
logged; the page shows only a masked hint. Leaving a secret field blank keeps the saved secret. Switching between test
and live mode needs the secret again, because test and live keys are different.

## Paytm

| Field             | Where to find it                                                                   |
| ----------------- | ---------------------------------------------------------------------------------- |
| Merchant ID (MID) | Paytm dashboard → Developer Settings → API Keys (test or production)               |
| Merchant key      | Same page; 16 characters                                                           |
| Website name      | Same page. Leave it blank for `WEBSTAGING` in test mode and `DEFAULT` in live mode |

- **Webhooks:** in Developer Settings → Webhooks, set both the **Payment Status** URL and the **Refund Notification**
  URL to the gateway's webhook URL. Paytm only calls URLs on port 443. Paytm signs payment webhooks with
  `CHECKSUMHASH` and refund webhooks with `head.signature`, both made with the merchant key; refund webhooks are then
  confirmed with Paytm's Refund Status API.
- **Checksum:** the API implements Paytm's documented checksum: a salted SHA-256 of the request, encrypted with
  AES-128-CBC under the merchant key. Its tests check it against values produced by Paytm's own checksum library.
- **Test connection** starts a ₹1 transaction and never completes it: it proves the MID, key and website name.
- **Hosts:** checkout loads from `securestage.paytmpayments.com` (test) or `secure.paytmpayments.com` (live); the API
  calls `securegw-stage.paytmpayments.in` or `securegw.paytmpayments.in`.

## Razorpay

| Field          | Where to find it                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Key ID         | Razorpay dashboard → Account & Settings → API Keys. `rzp_test_…` in test mode, `rzp_live_…` in live mode |
| Key secret     | Shown once when the key is generated                                                                     |
| Webhook secret | The secret you enter when creating the webhook. Leave it blank if you used the key secret there          |

- **Webhooks:** in Account & Settings → Webhooks, add the webhook URL with the events `payment.captured`,
  `payment.failed`, `order.paid`, `refund.processed` and `refund.failed`. Test mode and live mode have separate webhook
  lists: add it in both. Razorpay signs with `X-Razorpay-Signature`, an HMAC-SHA256 of the body with the webhook
  secret.
- **Capture:** keep automatic capture on in the dashboard's payment capture settings. An authorized but uncaptured
  payment stays pending.
- **Test connection** lists one order. A test key in live mode, or a live key in test mode, is refused with a message.
- **Checkout** is Razorpay Standard Checkout (`checkout.razorpay.com/v1/checkout.js`).

## Cashfree

| Field              | Where to find it                           |
| ------------------ | ------------------------------------------ |
| Client ID (App ID) | Cashfree dashboard → Developers → API Keys |
| Client secret      | Same page                                  |

- **Webhooks:** in Developers → Webhooks, add the webhook URL for the payment events (success, failed, user dropped)
  and the refund events. Each order also carries the URL as its `notify_url`. Cashfree signs with
  `x-webhook-signature`, a base64 HMAC-SHA256 of `x-webhook-timestamp` followed by the body, keyed with the client
  secret, so there is no separate webhook secret.
- **Whitelisting:** live mode only accepts return URLs on domains whitelisted in the dashboard
  ([Cashfree: whitelisting](https://www.cashfree.com/docs/payments/online/go-live/whitelist)). Whitelist the API's
  domain, and ask Cashfree support to enable UPI intent payments from an Android WebView for the app.
- **Test connection** looks up an order that doesn't exist: Cashfree's "not found" answer proves the keys.
- **API:** version `2026-01-01`, at `sandbox.cashfree.com/pg` (test) or `api.cashfree.com/pg` (live), with the
  Cashfree JS SDK v3 for checkout.

## Webhooks

| Account                       | Webhook URL                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| Institute (fees)              | `${API_PUBLIC_URL}/api/fees/public/webhooks/<gateway>/<webhook key>` |
| Platform (SaaS subscriptions) | `${API_PUBLIC_URL}/api/subscriptions/public/webhooks/<gateway>`      |

The settings page shows the full URL with a copy button. The institute URL contains a random key that identifies the
institute's configuration: treat it like a secret. Webhooks are rate limited per client IP by
`RATE_LIMIT_WEBHOOK_PER_MIN` ([rate limiting](../deployment.md#rate-limiting-behind-the-proxy)).

Every event's signature is verified before anything is read from it. The answers:

- `200` for events applied, ignored (an event type the app doesn't use) or already processed. Replays are safe.
- `401 INVALID_SIGNATURE` when the signature doesn't match: check the webhook secret or key.
- `404` for a webhook URL that leads nowhere: an unknown institute key, or a gateway the platform hasn't set up.
- `400 INVALID_WEBHOOK` for a signed event that can't be read.
- `503 GATEWAY_UNAVAILABLE` when the event was signed but the follow-up status call to the gateway failed. The vendor
  retries the webhook later.

## Checkout on the web and in the apps

Payers pay from **My fees** and the course purchase page, and institutes pay their subscription from
**Subscription & billing**. Each opens the gateway's standard checkout and, when it ends, asks the API to check the
payment with the gateway.

| Platform | How the checkout runs                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web      | Over the page. A checkout that redirects (3-D Secure, net banking) comes back through the return link                                                                                   |
| Android  | In the app's WebView. Gateway and bank pages stay in the app, and UPI links (`upi:`, `intent:` and Paytm's UPI bridge) open the payer's UPI apps. The return link brings the payer back |
| iOS      | In the app's WebView. Links to UPI and bank apps open those apps, and the return link brings the payer back                                                                             |

- **Return link:** `/api/fees/public/checkout-return/<token>` or `/api/subscriptions/public/checkout-return/<token>`,
  accepting GET or POST. The token is signed and valid for 7 days, and names only the payment, the app and the route;
  what the gateway posts to it is ignored. The API checks the payment with the gateway, then sends the payer to
  `PUBLIC_WEB_URL` (web), `https://localhost` (Android) or `capacitor://localhost` (iOS, through a small page).
- **Coming back another way:** if the payer leaves the gateway with the back button instead, the page that opened the
  checkout checks that payment when it loads again in the same session, within an hour.
- **Native access:** gateway pages stay in the WebView for at most 30 minutes after a checkout opens, and never get
  the app's native bridge: on Android it only answers the app's own origin, and on iOS messages from other origins are
  dropped. Paytm's UPI bridge only opens UPI app links, and only while a checkout is open.
- **Content Security Policy:** the web app's CSP allows the three vendors' checkout hosts
  ([security headers](../deployment.md#web-app-security-headers)). While it is still report-only, pay with each
  gateway you use, including a 3-D Secure card, and add any host the reports show before enforcing it.

## Reconciliation and idempotency

Webhooks can be lost, so the background jobs `fees.payment-reconcile` (each institute) and
`subscriptions.payment-reconcile` (the platform) ask the gateways about open payments every
`PAYMENT_RECONCILE_INTERVAL_MINUTES` (default 10), using the [job runner](../deployment.md#background-jobs).

- **Pending payments** are checked on every run from 2 minutes after the order until it's an hour old, then hourly,
  then every 6 hours after the first day, until they're 72 hours old. A failure reported in the first 30 minutes is
  left pending, because the payer may still retry in the same checkout, and payments failed within the last hour are
  checked again in case a retry succeeded.
- **Pending refunds** follow the same schedule for 30 days. A refund the gateway has never heard of after 5 minutes,
  because the request was interrupted, is sent again under the same reference, so the gateway can't refund twice.

Webhooks, these checks and the payer's return all go through one path. Each webhook event is recorded once, and a
payment or refund is posted once: duplicate webhooks, repeated checks and racing requests can't post a receipt, a
ledger entry, a refund or a subscription extension twice.

## Refunds

- **Online fee payments** are refunded through the gateway from the payment, in full or in part. The refund stays
  `pending` until the gateway reports it processed; only then is the ledger reversed and the payer notified. A failed
  refund posts nothing, and its amount can be refunded again.
- **Offline payments** are refunded at once: the app records the refund, and the money is returned outside it.
- **SaaS subscriptions** have no gateway refunds: the Super Admin issues a credit note and returns the money outside
  the app, for example from the vendor's dashboard.

## Testing in sandbox mode

Automated tests never call a vendor. CI and E2E use the mock gateway, and `backend/test/payment-gateways.test.ts` and
the adapter tests replace the HTTP client with fakes that answer like each vendor's sandbox.

To try a real sandbox:

1. Expose the API over `https://` with a tunnel and set `API_PUBLIC_URL` to the tunnel's URL, so webhooks and returns
   reach it.
2. Set up the gateway in test mode with the vendor's test keys, and add the webhook in the vendor's test dashboard.
3. Pay with the vendor's test cards, UPI IDs and banks:
   [Paytm](https://www.paytmpayments.com/docs/test-instruments/testing-integration),
   [Razorpay cards](https://razorpay.com/docs/payments/payments/test-card-details/),
   [Razorpay UPI](https://razorpay.com/docs/payments/payments/test-upi-details/),
   [Cashfree](https://www.cashfree.com/docs/payments/online/resources/data-to-test-integration).
4. Check that the payment is posted, refund it, and check that the refund is processed.

## Not yet verified with real accounts

Everything above is built against the vendors' published APIs and tested with recorded responses and the vendors'
published examples, but these need a real merchant account or device:

- **All three:** test connection with real keys, and a full payment, webhook, refund and reconciliation cycle in test
  and live mode.
- **Paytm:** the codes its status API returns in practice, and JS Checkout inside the Android and iOS WebViews,
  including UPI app handoff on iOS.
- **Razorpay:** the redirect flow inside the Android WebView and 3-D Secure in the iOS WebView.
- **Cashfree:** where live responses put the payment status, the WebView UPI flag, and acceptance of the return and
  notification URLs.
- **Devices:** handing off to UPI apps on Android, opening UPI and bank apps on iOS, and the iOS return page reopening
  the app.
- **Web:** the vendors' checkout overlays above the app's dialogs, and the CSP in enforce mode with 3-D Secure pages.
- **Platform fallback:** fee payments through the platform's Razorpay or Paytm account get no webhooks and rely on the
  payer's return and reconciliation.
- **Razorpay retries:** an order whose first attempt failed and a retry succeeded stays pending until the next check.
