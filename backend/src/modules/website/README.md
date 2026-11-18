# Website builder & online admissions (spec 4.13)

Block-based institute website: pages are built from blocks (hero, rich text, image/gallery, course list,
batch list, faculty, testimonials, announcements, enquiry form, demo-class form, contact/map, CTA).
Pages move through draft, preview and publish. Every publish saves a version that can be restored.
Branding and SEO are per site. The public site is rendered on the server and cached.

## Public routes (no auth)

These routes are mounted under `/api/public/sites/:site`. `:site` is the institute slug. It can also be
`_host`, which resolves the site from the `Host` header: a custom domain or
`<subdomain>.<platform domain>`.

| Route                                           | Purpose                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /` and `GET /p/:page`                      | Server-rendered HTML for the live site, cached and with a strict CSP. Add `?format=json` for JSON.                                                                  |
| `GET /site`, `GET /pages/:page`, `GET /resolve` | JSON payloads for a lightweight SPA or for a proxy.                                                                                                                 |
| `GET /sitemap.xml`, `GET /robots.txt`           | SEO. Pages marked non-indexable, and sites marked non-indexable, are excluded.                                                                                      |
| `POST /forms/:page`                             | Enquiry and demo-class forms. Submissions create **admissions enquiries** through the admissions service, with source `website` and the referral code when present. |
| `GET /r/:code`, `POST /referrals/:code/click`   | Referral link. Records a click (deduplicated by visitor hash), redirects to the home page with `?ref=<code>`, which the forms and CTAs carry forward.               |
| `POST /coupons/validate`                        | Coupon preview for the checkout UI.                                                                                                                                 |
| `GET` or `POST /checkout/:courseId`             | Checkout handoff (see below). Falls back to online admission (self-registration).                                                                                   |
| `GET /media/:fileId`                            | Redirects to a signed URL for site images.                                                                                                                          |

### Custom domains and subdomains

Point the reverse proxy for `*.platform-domain` and for each mapped custom domain to
`/api/public/sites/_host/...`, and preserve the `Host` header.

## Admin API (`/api/website/...`, permission module `website`)

- `site`: get or update domains, theme, SEO and the default branch. Updating requires `configure`.
- `pages`: CRUD, plus `publish` and `unpublish` (require `publish`), `versions` with
  `versions/:versionId/restore`, and `preview`, which returns `{ html }` rendered from the draft.
- `announcements`: CRUD.
- `coupons`: CRUD, plus `validate` and `:id/redemptions`.
- `referrals`: CRUD and `:id/events`. Clicks, signups, purchases and conversion stats are tracked.

## Using the module from other modules

Import from `modules/website/api.ts` only, and register hooks from your own `integrations.ts` in
`onReady`.

- `setCheckoutHandoff(fn)`: fees/payments returns `{ url }` to its checkout for
  `{ courseId, batchId, couponCode, referralCode, returnUrl }`. If it returns `null`, the visitor is sent
  to online admission. The input also carries `appUrl` (the staff/student app). Fees uses it to return
  `<appUrl>/my-fees/buy/:courseId?batchId&coupon&ref` when the course has an active fee structure and a
  payment gateway is enabled. Once the purchase is paid, fees admits the student and enrols them in the
  batch chosen at checkout (else an open batch of the course with seats), or queues them for an admin
  under Fees → Course enrolments; see the wiring table in `CONTRIBUTING.md`.
- `setCoursePriceResolver(fn)`: display prices for the public course catalogue. Fees returns the lowest
  active course-level fee structure total.
- `validateCoupon({ code, amountPaise, courseId?, customerKey? })`: returns the discount or a reason
  why the coupon cannot be applied. It checks validity dates, global and per-customer usage limits,
  minimum order and course scope.
  - `redeemCoupon({ ..., orderRef })`: call once payment is captured. It is idempotent per
    `orderRef` and locks the coupon row.
  - `releaseCoupon({ code, orderRef })`: call on refund or cancellation.
  - `computeDiscountPaise(coupon, amount)`: pure helper.
- `recordReferralConversion({ code, kind: 'signup' | 'purchase', refType, refId, amountPaise? })`:
  attributes a conversion to a referral code. It is idempotent per `(kind, refType, refId)`.
