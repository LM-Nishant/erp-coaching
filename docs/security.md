# Security

This document covers the security controls of spec §9 and how each one is enforced and tested. It
also lists the findings of the release-readiness review (November 2026), fixed and open, and the
dependency and secret scanning policy.

For deployment hardening (TLS, nginx, secrets on the host) see
[deployment.md](deployment.md). For the tenancy and RBAC model see
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Controls

### Tenant isolation and authorization

- **Tenant.** The institute comes only from the verified access token; anything a client sends is
  ignored. `TenantRepository` and the `registerTenantModel()` hooks scope every query. Another
  institute's record answers **404**, never 403.
- **Branches.** Branch-restricted staff see and change only their branches' rows:
  - `TenantRepository.assertBranchAssignable()` stops them moving a row to another branch or
    making it institute-wide (`branchId: null`);
  - `assertRowWritable()` guards rows loaded outside the repository.
- **Members.** `assertMemberInBranchScope()` in `permissions/access.service.ts` applies to member
  management (users, roles, devices):
  - members outside the caller's branches answer 404;
  - only members whose every assignment is inside the caller's branches can be changed (403
    `BRANCH_FORBIDDEN` otherwise).
- **Portals.** Students reach only their own records and guardians only their children's
  (`assertGuardianOf`).
- **Permissions.** Every authenticated institute route has `requirePermission(module, action)`
  unless it is listed as self-service.

The `backend/test/security` suite enforces all of this for **every route in the route registry**,
including routes added later. See [CONTRIBUTING.md](../CONTRIBUTING.md#authorization-and-tenant-isolation-suite).
It has three parts:

- `route-registry.test.ts` checks the guards:
  - authentication, permission and rate limiter on every route;
  - public routes under `/api/public`;
  - `/api/admin` super-admin only.
- `authz-sweep.test.ts` checks denials: 401 anonymous, 403 `PERMISSION_DENIED`, 403
  `SUPER_ADMIN_ONLY` and 403 `MODULE_DISABLED`.
- `tenant-isolation.test.ts` has a positive and a negative probe for every record route:
  - cross-institute;
  - cross-branch;
  - student vs student, guardian vs another child, employee vs employee;
  - public website sites;
  - list endpoints.

### Secure headers

The API sets Helmet's defaults on every response:

| Header                                               | Value                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`                            | `default-src 'self'`, `object-src 'none'`, `script-src 'self'`, `frame-ancestors 'self'`, … |
| `Strict-Transport-Security`                          | `max-age=31536000; includeSubDomains`                                                       |
| `X-Content-Type-Options`                             | `nosniff`                                                                                   |
| `X-Frame-Options`                                    | `SAMEORIGIN`                                                                                |
| `Referrer-Policy`                                    | `no-referrer`                                                                               |
| `Cross-Origin-Opener-Policy`                         | `same-origin`                                                                               |
| `Cross-Origin-Resource-Policy`                       | `cross-origin`, so the app (another origin, or the native webview) can load media           |
| `X-Powered-By`                                       | removed                                                                                     |
| `X-DNS-Prefetch-Control`, `X-Download-Options`, etc. | Helmet defaults                                                                             |

CORS allows only `CORS_ORIGINS`.

Nginx sets the web app's headers: HSTS, CSP, frame, referrer and permissions policies (see
[deployment.md](deployment.md)). It leaves the API's own headers unchanged.

**Uploaded files** are served from `/api/files/signed/:token`, the institute logo and the public
website's media. They never use the uploader's MIME type as is (`shared/utilities/file-response.ts`):

| Stored type                      | Served as                                              |
| -------------------------------- | ------------------------------------------------------ |
| `image/*` (SVG included)         | inline, with a sandbox CSP (no script, no network)     |
| PDF, audio and video             | inline (a sandbox would break the built-in PDF viewer) |
| `text/*`                         | inline as `text/plain`, with the sandbox CSP           |
| anything else                    | `application/octet-stream` attachment                  |
| HTML, XHTML and executable types | rejected on upload (400)                               |

All of them send `nosniff` and an RFC 6266 `Content-Disposition` with the original file name (exposed to the
app through CORS, so downloads keep their names). The app shows stored PDFs in an `<iframe>` from its own origin
(web dev server, `capacitor://localhost`, `https://localhost`), so file responses replace `frame-ancestors 'self'`
with `'self'` plus `CORS_ORIGINS` and `PUBLIC_WEB_URL`, and drop `X-Frame-Options`. Generated PDFs (fee receipts,
SaaS invoices, payslips, scorecards) are opened in a new tab through signed links or downloaded as blobs, never
framed.

### Rate limiting

Every limiter counts per client IP and has its own budget, so one kind of traffic can't use up
another's: website forms behind a school's NAT don't lock out its logins. Limited requests get
**429** `{ error: { code: 'RATE_LIMITED' } }` and the draft-8 `RateLimit` headers.

| Limiter       | Applies to                                                                                     | Default      | Variable                     |
| ------------- | ---------------------------------------------------------------------------------------------- | ------------ | ---------------------------- |
| `api`         | every `/api` request except signed media and HLS                                               | 600 / min    | `RATE_LIMIT_API_PER_MIN`     |
| `media`       | `/api/files/signed/*`, `/api/lms/public/hls/*`                                                 | 3000 / min   | `RATE_LIMIT_MEDIA_PER_MIN`   |
| `auth`        | password login, OTP request and OTP verify                                                     | 30 / 15 min  | `RATE_LIMIT_AUTH_MAX`        |
| `token`       | token refresh and logout                                                                       | 600 / 15 min | `RATE_LIMIT_TOKEN_MAX`       |
| `public-form` | anonymous writes: website forms, coupons, checkout, referral clicks, student self-registration | 60 / 15 min  | `RATE_LIMIT_PUBLIC_FORM_MAX` |
| `device`      | biometric device pushes                                                                        | 120 / min    | `RATE_LIMIT_DEVICE_PER_MIN`  |
| `webhook`     | payment gateway webhooks (the signature is verified in the handler)                            | 300 / min    | `RATE_LIMIT_WEBHOOK_PER_MIN` |

Some limits sit outside the limiters:

- OTPs expire after `OTP_TTL_SECONDS` and allow `OTP_MAX_ATTEMPTS` tries.
- A user can have at most `MAX_ACTIVE_DEVICES` active devices; every further new device needs an
  OTP.
- Behind a proxy, set `TRUST_PROXY` to the number of proxies (1 behind the bundled nginx).
  Otherwise every client shares the proxy's IP and budget.
- `RATE_LIMIT_ENABLED=false` is for tests and load runs only.

The route-registry test fails if a route lacks the `api` limiter, or an anonymous write lacks a
dedicated one. Counters are kept in memory, per API process (see [open findings](#open-findings)).

### Input validation

- **Validation.** Handlers parse bodies, queries and params with zod (`parse()`); a failure is
  400 `VALIDATION_ERROR` with the failing paths.
- **Body limits.** JSON bodies are limited to 1 MB.
- **Uploads.** Limited to `MAX_UPLOAD_MB`, the plan's storage quota and the blocked types above.
- **SQL.** Queries go through Sequelize with bound parameters. Raw SQL fragments interpolate only
  numbers, `sequelize.escape()`d values, or operator-supplied database and table names in the
  database CLI.

### Secrets

- **Where secrets live.** Only in the environment: `backend/.env` locally, and the deployment's
  environment file on servers. Both are gitignored.
- **Examples.** `backend/.env.example`, `app/.env.example` and `deploy/.env.example` list every
  variable without real values.
- **Production checks.**
  - The API refuses to start in production unless `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY` and
    `FILE_URL_SECRET` are set (16+ characters).
  - `db:seed` refuses to run in production with the README passwords: `SEED_SUPERADMIN_PASSWORD`
    needs 12+ characters and must not be the default. With `SEED_DEMO_DATA`, `SEED_DEMO_PASSWORD`
    must be changed too.
- **Encryption at rest.** Stored third-party secrets are encrypted with AES-256-GCM under
  `ENCRYPTION_KEY`:
  - the AI API key;
  - payment-gateway credentials;
  - messaging-provider credentials;
  - LMS content keys.

  The API only ever returns a masked hint.

- **Logs.** These are redacted:
  - the `Authorization` and `Cookie` headers;
  - password, token, OTP, API key and secret fields;
  - tokens in URLs: signed files, HLS, webhook keys and `token`, `code`, `otp`, `key` and
    `signature` query parameters.
- **Rotation:**
  - **`JWT_ACCESS_SECRET`**: access tokens expire within 15 minutes and refresh tokens are opaque
    database rows, so clients silently get a new access token.
  - **`FILE_URL_SECRET`**: invalidates outstanding signed URLs, which last at most
    `SIGNED_URL_TTL_SECONDS`.
  - **`ENCRYPTION_KEY`**: can't be rotated yet, because there is no re-encryption tool (see open
    findings).

### Signed media URLs

- **Issuing URLs.** `GET /api/files/:id/url` returns an HMAC-signed URL (`FILE_URL_SECRET`). It
  expires after `SIGNED_URL_TTL_SECONDS` (default 300 s).
- **Serving.** `/api/files/signed/:token` checks the signature and expiry and serves the file with
  Range support and `Cache-Control: private, max-age=60`.
- **Storage.** Files are never served from a public directory.
- **LMS.** Video goes through per-session HLS tokens.

The release-readiness test checks that a signed URL stops working after its TTL.

### Logging and error tracking

- **Logs.** Structured JSON logs, with a request id (`X-Request-Id`, sanitised) on every entry, plus
  the institute and user once authenticated.
- **Error tracking.** Unhandled 5xx errors go to the optional error tracker
  (`ERROR_TRACKING_PROVIDER=log|webhook`).
  - Events carry the route pattern, never the URL or body.
  - Webhook events are capped per minute.

See [deployment.md](deployment.md).

## Dependency and secret scanning

- **Audit gate.** The `Dependency audit` CI job runs `node scripts/audit-check.mjs` on every pull
  request, every push to main and nightly. It fails on:
  - advisories of **high** or above in production dependencies (`AUDIT_LEVEL_PROD`);
  - **critical** advisories anywhere, dev tooling included (`AUDIT_LEVEL_ALL`).

  Lower findings are printed but don't fail the build.

- **Exceptions.** They go in `.github/audit-allowlist.json`. Add one only when:
  - no fixed release exists;
  - you have checked that the vulnerable code isn't reachable with untrusted input;
  - the entry has the advisory id, the package, the reasoning and an `expires` date at most 90
    days out.

  After that date the job fails again until someone re-checks. Remove the entry when a fix ships.

- **Dependabot** (`.github/dependabot.yml`) proposes grouped weekly updates for npm, GitHub
  Actions, Docker base images and the Compose stack.
- **Secret scanning.** The `Secret scan` CI job runs gitleaks over the full git history, with the
  default rules plus `.gitleaks.toml`. Fake keys in tests must start with `sk-test-`. To run it
  locally: `gitleaks git .`

## Review findings (November 2026)

### Fixed

| Severity | Finding                                                                                                                                                                                                      | Fix                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| High     | Uploads, the institute logo and website media were served inline with the uploader's MIME type, so an HTML or SVG upload ran script on the API origin (stored XSS)                                           | Type-based serving policy, sandbox CSP, `nosniff`, HTML and XHTML uploads blocked (`file-response.ts`)                          |
| High     | `db:seed` in production created the super admin and demo users with the passwords published in the README                                                                                                    | `assertSafeForProduction()` in the demo seeder                                                                                  |
| High     | Login, OTP, token refresh and every public form shared one limiter, so normal refresh traffic from one NAT locked out logins. Payment webhooks and logout had no dedicated limiter                           | Separate `auth`, `token`, `public-form`, `device`, `webhook` and `media` limiters; the route-registry test requires them        |
| High     | Branch-restricted staff could update, delete, re-key or import into other branches' attendance devices, HR shifts and admission forms, and could move rows to another branch or make them institute-wide     | `assertBranchAssignable()` and `assertRowWritable()` in `TenantRepository`, applied in the attendance, HR and admissions routes |
| High     | Branch-restricted staff could view any member of the institute, and change roles of, remove or revoke devices of members outside their branches                                                              | `assertMemberInBranchScope()` and `memberVisibilityWhere()` in the users and auth routes                                        |
| High     | The `console` messaging adapter, the only SMS provider, wrote every message body to the production log, including login OTPs. Anyone who could read the logs could request an OTP for any mobile and sign in | In production it logs only the channel, a masked recipient and a message id, and keeps no outbox (`console.provider.ts`)        |
| Medium   | Academics class sessions of other branches were readable by branch-restricted staff                                                                                                                          | Branch scope on the class-session reads                                                                                         |
| Medium   | A teacher's appointment availability was readable across institutes and branches                                                                                                                             | Availability checks the teacher's institute and branch                                                                          |
| Low      | The HR employee-candidate picker and the academics teacher and student pickers listed users of other branches. The academics pickers also failed with 500 on main                                            | Pickers filter by branch visibility; the role join is kept out of the `LIMIT` subquery                                          |
| Low      | A student's batch history answered 200 with an empty list for students outside the caller's scope (an existence oracle)                                                                                      | 404 outside the caller's scope                                                                                                  |
| Low      | A client-supplied `X-Request-Id` was echoed and logged unchanged (log injection)                                                                                                                             | Accepted only if it matches `[\w.:-]{1,64}`; replaced otherwise                                                                 |

Regression tests for these live in `backend/test/security/*` and `backend/test/release-readiness.test.ts`.

### Open findings

None of these is critical or high. Tracked findings that the isolation suite detects are also
listed in `KNOWN_FINDINGS` in `backend/test/security/coverage.ts`. The suite fails once they are
fixed, until the entry is removed.

| Severity | Finding                                                                                                                                                                                                                                         | Recommendation                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | The audit log (`GET /api/audit-events`) isn't branch-filtered: branch-restricted staff with audit access see events and metadata from every branch                                                                                              | Filter by the event's branch, or restrict the audit log to institute-wide roles                                                                                                                |
| Medium   | Rate-limit counters are in memory, per API process. With several API instances each has its own budget                                                                                                                                          | Use a shared store (Redis) for `express-rate-limit` before scaling out; see [deployment.md](deployment.md)                                                                                     |
| Medium   | Password hashing uses `bcryptjs` (pure JavaScript) on the event loop, so bursts of logins slow every other request                                                                                                                              | Move to native `bcrypt` or `argon2`, or a worker pool                                                                                                                                          |
| Medium   | No per-account lockout: the `auth` limiter is per IP, so a distributed attacker can keep guessing one account's password                                                                                                                        | Add a per-mobile failure counter with a back-off                                                                                                                                               |
| Medium   | An institute can map any custom domain to its website without proving that it owns it. Domains are unique, so an institute can claim another's domain first, or take over one whose DNS still points at the platform after its owner removed it | Verify ownership (a DNS TXT record) before a domain resolves. Until then, operators confirm ownership before issuing the certificate ([deployment.md](deployment.md#institute-custom-domains)) |
| Low      | OTPs are stored as an unkeyed SHA-256 hash of the code and mobile. Six digits can be brute-forced offline from a database dump                                                                                                                  | Hash with an HMAC keyed by a server secret                                                                                                                                                     |
| Low      | OTP requests for an unknown mobile still create OTP rows (bounded by the `auth` limiter)                                                                                                                                                        | Don't store a row, or purge them aggressively                                                                                                                                                  |
| Low      | Long-lived media credentials: LMS offline download URLs last 1 hour and live-class join tokens 4 hours                                                                                                                                          | Shorten them, or bind them to the device                                                                                                                                                       |
| Low      | Signed-file and HLS routes rely only on the `media` limiter (3000/min per IP)                                                                                                                                                                   | Lower it if abuse appears; consider a per-token cap                                                                                                                                            |
| Low      | Public website GET pages have only the general `api` limiter                                                                                                                                                                                    | Cache them at nginx, or give them a dedicated limiter                                                                                                                                          |
| Low      | Website `_host` resolution falls back to the first DNS label of any unmapped host, so any domain whose first label is a site's subdomain serves that site                                                                                       | Accept the subdomain fallback only under the sites domain (`SITES_DOMAIN` in the deployment). Unknown names get a certificate mismatch from the bundled nginx today                            |
| Low      | Biometric device pushes check the punch count only after parsing the whole body (bounded by the 1 MB body limit)                                                                                                                                | Cap the array in the schema before processing                                                                                                                                                  |
| Low      | The tenant hooks check that a query has an `instituteId` condition, not that it is the current institute's                                                                                                                                      | Compare it with the context's institute (defence in depth)                                                                                                                                     |
| Low      | Institute creation doesn't check that the chosen plan is active (super-admin only)                                                                                                                                                              | Reject inactive plans                                                                                                                                                                          |
| Low      | `GET /api/guardians` for branch-restricted staff names a guardian's children in other branches                                                                                                                                                  | Filter the children by the caller's branches                                                                                                                                                   |
| Low      | `ENCRYPTION_KEY` can't be rotated: encrypted values carry no key id and there is no re-encryption tool                                                                                                                                          | Add a key id and a re-encryption command                                                                                                                                                       |

### Dependency advisories (at release)

| Severity | Advisory                                           | Path                                                    | Status                                                                                                                                         |
| -------- | -------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | picomatch ReDoS ([GHSA-fc5q-39xc-vjpf][picomatch]) | production: umzug → tinyglobby; dev: vite, vitest, etc. | No fixed release. Not reachable: the migrator hands umzug an explicit file list and no user input becomes a glob. Allowlisted until 2027-02-15 |
| Moderate | uuid ([GHSA-w5hq-g745-h8pq][uuid])                 | production: sequelize                                   | Affects v3/v5/v6 with a caller-supplied buffer, which isn't used. Below the production threshold                                               |
| Moderate | minimatch, glob, js-beautify, editorconfig         | dev tooling only                                        | Below the dev threshold. Dependabot will propose fixes                                                                                         |
| Low      | esbuild dev server                                 | dev tooling only                                        | Affects the dev server on Windows. Dependabot will propose fixes                                                                               |

[picomatch]: https://github.com/advisories/GHSA-fc5q-39xc-vjpf
[uuid]: https://github.com/advisories/GHSA-w5hq-g745-h8pq
