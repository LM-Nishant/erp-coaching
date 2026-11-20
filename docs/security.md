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
  institute's record answers **404**, never 403. The hooks also reject any write (create, save,
  bulk create, upsert, update or destroy) for an institute other than the request's.
- **Branches.** Branch-restricted staff see and change only their branches' rows:
  - `TenantRepository.assertBranchAssignable()` stops them moving a row to another branch or
    making it institute-wide (`branchId: null`);
  - `assertRowWritable()` guards rows loaded outside the repository.
- **Members.** `assertMemberInBranchScope()` in `permissions/access.service.ts` applies to member
  management (users, roles, devices):
  - members outside the caller's branches answer 404;
  - only members whose every assignment is inside the caller's branches can be changed (403
    `BRANCH_FORBIDDEN` otherwise).
- **Audit log.** Each event records its branch: the branch in its metadata, else the branch a
  branch-restricted actor was working in, else none (institute-wide). `GET /api/audit-events`:
  - branch-restricted users see only their branches' events (the selected branch's, if one is
    selected);
  - events without a branch, such as settings, roles and integrations, are shown only to users
    with every branch: they can't be tied to a branch, so they could describe any branch's data;
  - users with every branch who select a branch see its events and the institute-wide ones.
- **Guardians.** `GET /api/guardians` lists, and names, only the children in the caller's branches.
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
framed. Report exports skip signed links: `GET /api/reports/exports/:id/download` sends the file to its creator only,
as an attachment with its own type (so a CSV is `text/csv`, never shown inline), and audits every download.

### Rate limiting

Every limiter has its own budget, so one kind of traffic can't use up another's: website forms
behind a school's NAT don't lock out its logins. They count per client IP, except `media-token`,
which counts per link. Limited requests get **429** `{ error: { code: 'RATE_LIMITED' } }` and the
draft-8 `RateLimit` headers.

| Limiter       | Applies to                                                                                     | Default      | Variable                             |
| ------------- | ---------------------------------------------------------------------------------------------- | ------------ | ------------------------------------ |
| `api`         | every `/api` request except signed media, HLS and the public website                           | 600 / min    | `RATE_LIMIT_API_PER_MIN`             |
| `media`       | `/api/files/signed/*`, `/api/lms/public/hls/*` and website images                              | 3000 / min   | `RATE_LIMIT_MEDIA_PER_MIN`           |
| `media-token` | each signed file URL or HLS token, whatever the client IP: caps a leaked or shared link        | 300 / min    | `RATE_LIMIT_MEDIA_PER_TOKEN_PER_MIN` |
| `website`     | public website reads: pages, sitemaps, `robots.txt`, short links and checkout pages            | 300 / min    | `RATE_LIMIT_WEBSITE_PER_MIN`         |
| `auth`        | password login, OTP request, OTP verify and profile selection                                  | 30 / 15 min  | `RATE_LIMIT_AUTH_MAX`                |
| `token`       | token refresh and logout                                                                       | 600 / 15 min | `RATE_LIMIT_TOKEN_MAX`               |
| `public-form` | anonymous writes: website forms, coupons, checkout, referral clicks, student self-registration | 60 / 15 min  | `RATE_LIMIT_PUBLIC_FORM_MAX`         |
| `device`      | biometric device pushes                                                                        | 120 / min    | `RATE_LIMIT_DEVICE_PER_MIN`          |
| `adms`        | ZKTeco/eSSL biometric devices: ADMS pushes and command polls on `/iclock/*`                    | 600 / min    | `RATE_LIMIT_ADMS_PER_MIN`            |
| `webhook`     | payment gateway and messaging webhooks, checkout returns (signature or URL key verified)       | 300 / min    | `RATE_LIMIT_WEBHOOK_PER_MIN`         |

Some limits sit outside the limiters:

- OTPs expire after `OTP_TTL_SECONDS` and allow `OTP_MAX_ATTEMPTS` tries.
- A mobile number gets at most `OTP_REQUESTS_PER_MOBILE` codes in 10 minutes, whether or not it
  has an account (then 429 `OTP_RATE_LIMITED`). Each device the user has signed in on has a
  budget of its own, so requests from elsewhere can't use up the user's.
- Failed sign-ins lock the account ([sign-in lockout](#passwords-otps-and-sign-in-lockout)).
- A user can have at most `MAX_ACTIVE_DEVICES` active devices; every further new device needs an
  OTP.
- Behind a proxy, set `TRUST_PROXY` to the number of proxies (1 behind the bundled nginx).
  Otherwise every client shares the proxy's IP and budget.
- `RATE_LIMIT_ENABLED=false` is for tests and load runs only.

The route-registry test fails if a route lacks the `api` limiter, an anonymous write lacks a
dedicated one, or a route the `api` limiter skips lacks its own (`media-token` on every link
route, `website` or `media` on website reads). With `REDIS_URL` set, every counter, the OTP and
sign-in ones included, is kept in Redis and shared by all API processes. Without it, or while
Redis is unreachable, each process counts in memory ([deployment.md](deployment.md#rate-limits)).

### Passwords, OTPs and sign-in lockout

- **Password hashing** (`infrastructure/password.ts`). New hashes use scrypt
  (N = 2^`PASSWORD_HASH_COST`, r = 8, p = 3: 32 MiB at the default cost of 15) on libuv's thread
  pool, so hashing never blocks the event loop. bcrypt hashes from earlier releases are verified
  in a worker thread and replaced at the user's next successful sign-in, as are scrypt hashes with
  older parameters. Unknown identifiers and accounts without a password are checked against a
  dummy hash, so they take as long as a wrong password.
- **OTP codes.** Stored as an HMAC-SHA256 keyed with `OTP_HASH_SECRET` over the challenge id, the
  mobile and the code, so a copy of the table doesn't give the codes away. Codes issued before this
  scheme simply expire.
- **Unknown numbers.** An OTP request for a number without an active account stores and sends
  nothing, but answers like a real one: a challenge id of the same shape, the time a real code
  takes, the same per-number limit, and wrong codes count towards the same attempts and lockout.
- **Shared numbers ("Who's signing in?").** Children who share a parent's mobile each have an
  account of their own. One account owns the number (`users.mobile`, unique); the others have no
  number of their own and are reached on it (`users.shared_mobile`): their OTPs, new-device codes,
  SMS and WhatsApp messages go to that number.
  - Nothing before the code is verified depends on how many accounts the number reaches: one
    code and one challenge (held by the number's first account), with the same answer, timing and
    per-number limit as a number with one account, or none.
  - A verified login code for a number with several active accounts returns `200 choose_profile`
    without tokens: the accounts' names, institutes and roles, and a selection token. The token
    works once, only on the device that verified the code, for `OTP_TTL_SECONDS`, and is stored
    as an HMAC keyed with `OTP_HASH_SECRET`.
  - `POST /api/auth/select-profile` with the token and one of those accounts signs in as it;
    anything else is 401 `PROFILE_SELECTION_INVALID`. The chosen account's own sign-in lock
    (429 `ACCOUNT_LOCKED`), device limit (`device_limit_reached`) and devices apply as for any
    sign-in, then institute selection and biometric unlock. A lock or a full device list leaves
    the token usable for another account. The audit log records `auth.login` with `profileChosen`.
  - Wrong codes count against the number's first account, per device of any of the number's
    accounts (every other device shares one scope), so a locked number stops OTP sign-in for all
    of its accounts until the lock ends. The account that signs in, offered or chosen, also keeps
    its own lock.
  - Password sign-in with the mobile reaches only the account that owns it. The others sign in
    with their email and password, or with the number's OTP.
  - "Switch profile" in the app's account menu sends a new code to the number and asks for it
    before offering the accounts. The account that was signed in is signed out on that device.
- **Failed SMS.** OTPs are sent while the request waits, through the platform SMS provider. When a
  code can't be sent (a vendor outage, or a vendor refusing one number, for example Twilio after
  its owner replied STOP), the operator always gets an error log and an error-tracking event, and
  the client's answer depends on the code:
  - **login code** (`POST /api/auth/otp/request`): the usual `200 otp_required` with a challenge id,
    so the response doesn't reveal that the number has an account. The user gets no code and can
    request another.
  - **new-device code** (after a correct password on a new device): `503 MESSAGE_NOT_SENT`, naming
    no vendor. The password already proved the account, so the failure reveals nothing new.
- **Sign-in lockout** (`authentication/sign-in-lock.ts`). Failed passwords, OTP codes and
  biometric unlocks count per account and scope:
  - each device the user has signed in on (until it's revoked) is a scope of its own, and every
    other device shares one. Guessing from elsewhere can't lock the user out of their devices;
  - after `LOGIN_LOCKOUT_THRESHOLD` failures (5) the scope locks for `LOGIN_LOCKOUT_BASE_SECONDS`
    (60 s), doubling with each further failure up to `LOGIN_LOCKOUT_MAX_SECONDS` (15 min).
    Attempts during a lock get 429 `ACCOUNT_LOCKED` with `Retry-After`, without the credential
    being checked, and don't extend it, so every lock ends by itself;
  - attempts for one account and scope run one at a time. A parallel one waits up to 3 s and then
    gets 429 `SIGN_IN_BUSY`, so parallel requests can't slip extra guesses in before the lock;
  - identifiers without an account are counted under a keyed tag of the identifier, so their
    answers match a real account's;
  - a successful sign-in clears its scope, and failures are forgotten a day after the last one;
  - admins with `users.edit` clear a member's locks from the member's devices
    (`DELETE /api/users/:id/sign-in-lock`), and the super admin from Admin › Users
    (`DELETE /api/admin/users/:id/sign-in-lock`);
  - the audit log records each lock (`auth.sign_in_locked`, with the method and device) and each
    clear (`auth.sign_in_unlocked`);
  - a wrong password given to attach an existing account to a self-registration counts too.
- **Sign-out.** Signing out ends every session of that device and turns its biometric unlock off.
  Its offline download links and live-class join tokens stop working too, and its live-class
  sockets and LiveKit connections are dropped ([signed media](#signed-media-urls)).

### Input validation

- **Validation.** Handlers parse bodies, queries and params with zod (`parse()`); a failure is
  400 `VALIDATION_ERROR` with the failing paths.
- **Body limits.** JSON bodies are limited to 1 MB. Biometric device pushes are read only after
  the device has authenticated, up to `BIOMETRIC_PUSH_MAX_KB` (256 KB by default; 413
  `PAYLOAD_TOO_LARGE` beyond), and more than 1000 punches are refused before the device adapter
  parses them.
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
  - The API refuses to start in production unless `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`,
    `FILE_URL_SECRET` and `OTP_HASH_SECRET` are set (16+ characters).
  - `db:seed` refuses to run in production with the README passwords: `SEED_SUPERADMIN_PASSWORD`
    needs 12+ characters and must not be the default. With `SEED_DEMO_DATA`, `SEED_DEMO_PASSWORD`
    must be changed too.
- **Encryption at rest.** Stored third-party secrets are encrypted with AES-256-GCM:
  - the AI API key;
  - payment-gateway credentials;
  - messaging-provider credentials;
  - platform integration secrets;
  - LMS content keys.

  Each value names the key that encrypted it (`v2:<key id>:…`). `ENCRYPTION_KEY` encrypts, and it
  and the keys in `ENCRYPTION_PREVIOUS_KEYS` decrypt. Models declare their encrypted columns with
  `registerEncryptedColumns()`, and `secrets:reencrypt` moves every registered column to the
  current key. The API only ever returns a masked hint.

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
  - **`ENCRYPTION_KEY`**: add the new key, keep the old one in `ENCRYPTION_PREVIOUS_KEYS` and run
    `secrets:reencrypt` ([runbook](deployment.md#rotating-the-encryption-key)).
  - **`OTP_HASH_SECRET`**: codes already sent stop working, and the OTP counters and the locks of
    identifiers without an account start again.

### Signed media URLs

- **Issuing URLs.** `GET /api/files/:id/url` returns an HMAC-signed URL (`FILE_URL_SECRET`). It
  expires after `SIGNED_URL_TTL_SECONDS` (default 300 s).
- **Serving.** `/api/files/signed/:token` checks the signature and expiry and serves the file with
  Range support and `Cache-Control: private, max-age=60`.
- **Storage.** Files are never served from a public directory.
- **Per link.** Besides the per-IP `media` limiter, each signed URL and HLS token has its own
  `media-token` budget.
- **LMS playback.** Video goes through per-user HLS tokens or signed links. They last the video's
  length plus 15 minutes (at most 6 hours), so playback isn't cut off.
- **Offline downloads.** The download link lasts 10 minutes and is bound to the device: it stops
  working once that device signs out, goes idle or is revoked. A download that has already started
  isn't cut off.
- **Live classes.** Join tokens, which a streaming vendor's SDK uses, are bound to the device in
  the same way. They last until 30 minutes after the scheduled end (at least 15 minutes, at most
  4 hours); a client renews one with `POST /api/live-classes/:id/join` before it expires. LiveKit
  tokens last 15 minutes, and LiveKit renews them while the participant stays connected. The
  built-in transport's sockets use the normal access token instead. Open live-class sockets are
  re-checked every minute and whenever the institute's subscription or status changes: a revoked,
  signed-out or idle device, an inactive user or institute, or a suspended subscription drops them.
- **LiveKit connections.** A LiveKit token's participant metadata, which participants can't
  change, names the device it was issued to:
  - when a device signs out or is revoked, the API removes the user's connection from every class
    live in their institutes, but only a connection made with that device's token, so the user's
    other devices stay connected;
  - a join that LiveKit reports from a device that is signed out, revoked or idle is removed at
    once and counts no attendance;
  - a socket that the re-check drops takes its media connection with it, unless the device still
    has an allowed socket in that class.

The release-readiness test checks that a signed URL stops working after its TTL.

### Website domains

- An institute's website is served on its custom domain only after the institute has proved that
  it controls the domain's DNS. It publishes the `TXT` record `_erp-verification.<domain>` with the
  value `erp-verification=<token>`, and selects **Verify domain** in the website settings
  (`POST /api/website/site/domain/verify`). The token is random, and changing the domain issues a
  new one and un-verifies it.
- If another institute later verifies the same domain, it moves to that institute; both audit
  logs record the move.
- Any other host gets a site only if it is one label directly under `SITES_DOMAIN` (the site's
  subdomain); unknown hosts get a 404.

See [deployment.md](deployment.md#institute-custom-domains).

### Biometric devices (ADMS)

ZKTeco and eSSL devices push attendance to `/iclock/*` at the server root
([biometric.md](integrations/biometric.md)). ADMS firmware can't send an API key or sign its
requests.

- **Identity.** The device's serial number identifies it, and the institute and branch come from its
  registration, never from the request. These all get the same 403 `DEVICE_FORBIDDEN`, before the
  body is read:
  - an unknown serial, or a disabled device;
  - an address outside the device's optional IP allowlist;
  - plain HTTP for a device that doesn't allow it;
  - an institute without the attendance module.
- **Serials aren't secret.** They are printed on the device. Anyone who knows a registered serial
  and can send from an allowed address could forge punches for mapped PINs, take the device's
  queued commands, or upload a fake user list or device info. Mitigations:
  - an IP allowlist, recommended for every device on a fixed address;
  - forged punches only mark attendance within the device's registration (its institute, and its
    branch if it has one), never overwrite an existing mark, show under Recent punches, and can be
    corrected like any other record;
  - replies contain no personal data: only acknowledgements and commands.
- **HTTPS by default.** Plain HTTP needs two opt-ins: `ADMS_ALLOW_HTTP=true` makes nginx serve
  `/iclock/` (and nothing else) on port 80, and **Allow plain HTTP** is set per device. Many
  devices only have firmware without HTTPS. The trade-off for those devices: their serial number,
  punches (PIN and time) and user lists (PIN, name and privilege) cross the internet unencrypted
  and can be altered on the way, and anyone on the path learns the serial. Prefer HTTPS-capable
  firmware, and combine plain HTTP with an IP allowlist.
- **No biometric data.** The server asks for no fingerprint or face templates or photos.
  Template and photo uploads that a device sends anyway are discarded. Of the device users, only
  PIN, name and privilege are stored.
- **Limits.** The `adms` limiter (and `api`), `ADMS_MAX_BODY_KB` on the declared size, the received
  size and unpacked data packets, `ADMS_MAX_RECORDS` before parsing, one request per device at a
  time (at most 8 waiting), and at most 20 queued commands per device.
- **Idempotency.** A punch is stored once per serial, PIN and time (a unique key), so re-sent
  records never count twice.
- **Secrets.** ADMS devices hold none, so nothing is stored for them in the encrypted settings.
  The `PushCommKey` query parameter that some firmware sends isn't documented, so it isn't
  checked; it is redacted from the logs.

The route-registry test requires the `adms` limiter on these routes, and the security suite lists
them with how the device is identified.

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

| Severity | Finding                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Uploads, the institute logo and website media were served inline with the uploader's MIME type, so an HTML or SVG upload ran script on the API origin (stored XSS)                                           | Type-based serving policy, sandbox CSP, `nosniff`, HTML and XHTML uploads blocked (`file-response.ts`)                                                                                                                                                            |
| High     | `db:seed` in production created the super admin and demo users with the passwords published in the README                                                                                                    | `assertSafeForProduction()` in the demo seeder                                                                                                                                                                                                                    |
| High     | Login, OTP, token refresh and every public form shared one limiter, so normal refresh traffic from one NAT locked out logins. Payment webhooks and logout had no dedicated limiter                           | Separate `auth`, `token`, `public-form`, `device`, `webhook` and `media` limiters; the route-registry test requires them                                                                                                                                          |
| High     | Branch-restricted staff could update, delete, re-key or import into other branches' attendance devices, HR shifts and admission forms, and could move rows to another branch or make them institute-wide     | `assertBranchAssignable()` and `assertRowWritable()` in `TenantRepository`, applied in the attendance, HR and admissions routes                                                                                                                                   |
| High     | Branch-restricted staff could view any member of the institute, and change roles of, remove or revoke devices of members outside their branches                                                              | `assertMemberInBranchScope()` and `memberVisibilityWhere()` in the users and auth routes                                                                                                                                                                          |
| High     | The `console` messaging adapter, the only SMS provider, wrote every message body to the production log, including login OTPs. Anyone who could read the logs could request an OTP for any mobile and sign in | In production it logs only the channel, a masked recipient and a message id, and keeps no outbox (`console.provider.ts`)                                                                                                                                          |
| Medium   | Academics class sessions of other branches were readable by branch-restricted staff                                                                                                                          | Branch scope on the class-session reads                                                                                                                                                                                                                           |
| Medium   | A teacher's appointment availability was readable across institutes and branches                                                                                                                             | Availability checks the teacher's institute and branch                                                                                                                                                                                                            |
| Medium   | The audit log (`GET /api/audit-events`) wasn't branch-filtered: branch-restricted staff with audit access saw events and metadata from every branch                                                          | Events record their branch; branch-restricted users see only their branches' events, and events without a branch only users with every branch ([tenant isolation](#tenant-isolation-and-authorization))                                                           |
| Medium   | Rate-limit counters were in memory, per API process, so each instance had its own budget                                                                                                                     | With `REDIS_URL`, a Redis store shared by all processes, with the in-memory store as the fallback; live-class sockets use the Socket.IO Redis adapter                                                                                                             |
| Medium   | Password hashing used `bcryptjs` on the event loop, so bursts of logins slowed every other request                                                                                                           | scrypt on libuv's thread pool; bcrypt hashes are verified in a worker thread and replaced at the next sign-in (`password.ts`)                                                                                                                                     |
| Medium   | No per-account lockout: the `auth` limiter is per IP, so a distributed attacker could keep guessing one account's password                                                                                   | Sign-in lockout per account and device, for passwords, OTPs and biometric unlocks, audited and cleared by admins ([lockout](#passwords-otps-and-sign-in-lockout))                                                                                                 |
| Medium   | An institute could map any custom domain to its website without proving that it owns it                                                                                                                      | DNS `TXT` verification; only verified domains are served ([website domains](#website-domains))                                                                                                                                                                    |
| Low      | The HR employee-candidate picker and the academics teacher and student pickers listed users of other branches. The academics pickers also failed with 500 on main                                            | Pickers filter by branch visibility; the role join is kept out of the `LIMIT` subquery                                                                                                                                                                            |
| Low      | A student's batch history answered 200 with an empty list for students outside the caller's scope (an existence oracle)                                                                                      | 404 outside the caller's scope                                                                                                                                                                                                                                    |
| Low      | A client-supplied `X-Request-Id` was echoed and logged unchanged (log injection)                                                                                                                             | Accepted only if it matches `[\w.:-]{1,64}`; replaced otherwise                                                                                                                                                                                                   |
| Low      | OTPs were stored as an unkeyed SHA-256 hash of the code and mobile, so six digits could be brute-forced offline from a database dump                                                                         | HMAC-SHA256 keyed with `OTP_HASH_SECRET`                                                                                                                                                                                                                          |
| Low      | OTP requests for an unknown mobile created OTP rows                                                                                                                                                          | Nothing is stored or sent; the answer, its timing and the per-number limit match a real account's                                                                                                                                                                 |
| Low      | LMS offline download URLs lasted 1 hour and live-class join tokens 4 hours, and both kept working after the device signed out                                                                                | Both are bound to the device. Offline links last 10 minutes, and join tokens until 30 minutes after the scheduled end (15 minutes to 4 hours; LiveKit's 15 minutes, renewed while connected). Signing a device out or revoking it removes its LiveKit connections |
| Low      | Signed-file and HLS routes relied only on the per-IP `media` limiter, and public website GET pages only on the general `api` limiter                                                                         | A per-link `media-token` limiter and a `website` limiter, both configurable; the route-registry test requires them                                                                                                                                                |
| Low      | Website `_host` resolution fell back to the first DNS label of any unmapped host                                                                                                                             | The fallback applies only to hosts one label under `SITES_DOMAIN`                                                                                                                                                                                                 |
| Low      | Biometric device pushes checked the punch count only after parsing the whole body                                                                                                                            | The body is read only after the device authenticates, up to `BIOMETRIC_PUSH_MAX_KB`, and the punch count is checked before the adapter parses it                                                                                                                  |
| Low      | The tenant hooks checked that a query had an `instituteId` condition, not that it was the current institute's                                                                                                | Writes for another institute than the request's are rejected                                                                                                                                                                                                      |
| Low      | Institute creation accepted an inactive plan (super admin only)                                                                                                                                              | 400 `PLAN_INACTIVE`                                                                                                                                                                                                                                               |
| Low      | `GET /api/guardians` named a guardian's children in other branches to branch-restricted staff                                                                                                                | Only children in the caller's branches are listed                                                                                                                                                                                                                 |
| Low      | `ENCRYPTION_KEY` couldn't be rotated: encrypted values carried no key id and there was no re-encryption tool                                                                                                 | Key ids, `ENCRYPTION_PREVIOUS_KEYS`, `secrets:reencrypt` and a [rotation runbook](deployment.md#rotating-the-encryption-key)                                                                                                                                      |
| Low      | Open live-class sockets were dropped when the device signed out, but not when the subscription was suspended or the device went idle                                                                         | Sockets are re-checked every minute and when the institute's subscription or status changes; a dropped socket's LiveKit connection is removed too                                                                                                                 |

Regression tests for these live in `backend/test/security/*` and, in `backend/test/`,
`release-readiness`, `security-hardening`, `auth-hardening`, `rate-store`, `live-sockets`,
`livekit-streaming`, `secrets-rotation` and `website` (`.test.ts`).

### Open findings

None of the review's findings is open. `KNOWN_FINDINGS` in `backend/test/security/coverage.ts`,
where the isolation suite tracks findings it detects, is empty. These residual risks of the fixes
remain:

| Severity | Residual risk                                                                                                                                                                                                                                                                                                               | Why it stays                                                                                                                                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low      | Someone who keeps failing sign-ins for an account can keep sign-in on **new** devices locked: every lock ends within `LOGIN_LOCKOUT_MAX_SECONDS`, but one more failure starts another. The same goes for the shared OTP request budget of a number. The user's own devices aren't affected                                  | All devices the user hasn't signed in on share one scope, because an attacker can change everything else a request carries. Telling the user's new phone apart from an attacker needs a signal the API doesn't have yet. Each lock is audited, admins can clear it, and operators can lower `LOGIN_LOCKOUT_MAX_SECONDS` or turn locks off with `LOGIN_LOCKOUT_THRESHOLD=0` |
| Low      | A device's scope, and its own OTP budget, are keyed by the device id the app sends. Someone who learns that id can count against the device's scope                                                                                                                                                                         | The id isn't shown to other users; the lock still ends by itself                                                                                                                                                                                                                                                                                                           |
| Low      | Identifiers without an account are counted per identifier, so trying an email and a mobile of the same person shows whether both belong to one account (one shared lock) or not                                                                                                                                             | Only if the attacker already knows both; merging them would need the account lookup the tag avoids                                                                                                                                                                                                                                                                         |
| Low      | An offline link or join token works again if the same user signs back in on the same device within its lifetime. A download that has started isn't cut off                                                                                                                                                                  | The binding is to the device's sign-in, not to a session. The lifetimes are short (10 minutes for offline links, 15 minutes for LiveKit tokens), and live-class sockets and LiveKit connections are dropped at once                                                                                                                                                        |
| Low      | A LiveKit connection without a classroom socket is removed when its device signs out or is revoked, and refused when it joins from a signed-out, revoked or idle device, but not dropped when the device later goes idle, the user is deactivated or the subscription is suspended                                          | The app always opens the classroom socket with the media connection, so only a modified client connects without one. Finding such connections would mean listing every live room's participants every minute. Ending the class or revoking the device removes it                                                                                                           |
| Low      | LiveKit connections made with tokens issued before this release name no device, so device events don't remove them                                                                                                                                                                                                          | Only classes running across the upgrade have them, and they end with the class                                                                                                                                                                                                                                                                                             |
| Info     | LiveKit identifies participants by user, so a connection the user makes from another device in the moment between the API's check of the device (`GetParticipant`) and the removal (`RemoveParticipant`) is removed instead. A revocation handled after the same device has signed in again also removes its new connection | LiveKit has no conditional removal, and the window is one API round trip (or the few seconds before the job runs). The user joins again                                                                                                                                                                                                                                    |
| Low      | LMS playback links aren't bound to the device and last the video's length plus 15 minutes (at most 6 hours)                                                                                                                                                                                                                 | Shorter links would cut long videos off. Each link has its own `media-token` budget                                                                                                                                                                                                                                                                                        |
| Low      | Each API process caches the custom-domain mapping for 60 seconds, so a domain that moves to another institute is served by the old one for up to a minute on other processes                                                                                                                                                | The cache keeps a database lookup off every website request                                                                                                                                                                                                                                                                                                                |
| Info     | During an SMS outage, users requesting a login code get the usual answer but no code                                                                                                                                                                                                                                        | Reporting the failure would reveal which numbers have accounts. The operator gets an error log and an error-tracking event                                                                                                                                                                                                                                                 |

### Dependency advisories (at release)

`npm audit` after the upgrades in this release:

| Severity | Advisory                                   | Path                                                    | Status                                                                                                                            |
| -------- | ------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| High     | picomatch ReDoS (GHSA-fc5q-39xc-vjpf)      | production: umzug → tinyglobby; dev: vite, vitest, etc. | Withdrawn by GitHub, so `npm audit` no longer reports it. Its allowlist entry was removed                                         |
| Moderate | uuid (GHSA-w5hq-g745-h8pq)                 | production: sequelize                                   | Fixed: the root `overrides` pin sequelize's `uuid` to `^11.1.1`                                                                   |
| Moderate | minimatch, glob, js-beautify, editorconfig | dev tooling only                                        | Fixed: overrides for `js-beautify`'s `editorconfig` (`^4.0.1`) and `glob` (`^14.0.2`)                                             |
| Low      | esbuild dev server (GHSA-g7r4-m6w7-qqqr)   | dev tooling only: tsup, vite                            | Open. It affects esbuild's dev server on Windows, which nothing here runs. The fix needs tsup 9, which Dependabot PR #24 proposes |
