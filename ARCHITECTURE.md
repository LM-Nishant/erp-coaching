# Architecture

## Monorepo

| Workspace                         | What                                                                         | Key tech                                                              |
| --------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/shared` (`@erp/shared`) | API DTOs, permission actions, system role slugs, AI presets, plan limit keys | TypeScript only, no runtime deps                                      |
| `backend`                         | REST API at `/api`, a modular monolith                                       | Express 5, Sequelize 6, MySQL 8, zod, pino, umzug, Vitest + supertest |
| `app`                             | Web portal and native apps from one codebase                                 | Vue 3, Ionic 8, Capacitor 8, Pinia, vue-router 4, Vite                |

## Backend layout (spec §6.2)

```
backend/src/
  server.ts / app.ts / bootstrap.ts     # process entry, express app, model+module init
  infrastructure/                        # technical adapters, no business rules
    config/              env parsing (zod), the single source of configuration
    database/            sequelize instance, umzug migrator, cli, migration-helpers, core migrations, seeders
    module-loader.ts     auto-discovers src/modules/*/index.ts
    storage/             StorageAdapter: local-disk (implemented), s3 (stub), signed URLs
    ai-providers/        OpenAI-compatible chat-completions client
    messaging/           SMS / WhatsApp / email / push providers (console impl + MSG91/Twilio/WhatsApp Cloud/SMTP/FCM stubs)
    payment-gateways/    PaymentGateway interface: mock (signed webhooks) + Paytm/Razorpay/Cashfree adapters (signature verification; API calls stubbed)
    streaming/ biometric/  interfaces + mock impls
    calendar/            CalendarProvider (Google Calendar/Meet stub + mock that issues meeting links)
    jobs/                DB-backed job queue + in-process worker
    crypto.ts logger.ts
  shared/                                # cross-cutting building blocks used by every module
    module.ts            defineModule() contract
    context.ts           AsyncLocalStorage request/job context (user, tenant, branches, permissions)
    tenancy/             registerTenantModel() guard hooks + TenantRepository
    middleware/          authenticate, requirePermission/requireModule/requireSuperAdmin, security, errors
    audit/               audit() service + AuditEvent model
    errors.ts utilities/ (zod parse, pagination)
  modules/                               # business modules, one folder each
    authentication users permissions institutes branches subscriptions platform tenant-data files ai audit
```

### Module loading

`module-loader.ts` imports every `src/modules/*/index.ts`. Each one default-exports `defineModule({...})`, and loading runs in this order:

1. `models(sequelize)` for every module.
2. Then `associate()` for every module.
3. Then `routes(apiRouter)`.
4. Then `permissions` are upserted into the `permissions` table. Default `grants` are applied to system roles on every boot.
5. Then `jobs` handlers are registered.
6. Finally `onReady()`. Modules use it for cross-module wiring: each provider module's `integrations.ts` registers into consumer extension points (notification recipient resolvers, grievance linked students, academics class-completed listeners). See CONTRIBUTING → "Cross-module wiring".

After `listen()`, `server.ts` calls each module's optional `attachServer(server)`. Use it for protocols that need the raw HTTP server, such as Socket.IO in `live-classes/realtime.ts`. Mount on a module-prefixed path and authenticate every connection.

**Adding a module never requires editing a shared file.**

### Migrations and seeders

The migrator (umzug) globs two sets of files:

- **Migrations**: `infrastructure/database/migrations/*.ts` plus `modules/*/migrations/*.ts`.
- **Seeders**: `infrastructure/database/seeders/*.ts` plus `modules/*/seeders/*.ts`.

Files are named `YYYYMMDDHHMMSS-description.ts` and run in global timestamp order. History is kept in `SequelizeMeta` and `SequelizeData`.

In production (`NODE_ENV=production`) the seeders create no demo institutes unless `SEED_DEMO_DATA=true`, and refuse to run while `SEED_SUPERADMIN_PASSWORD` is the README default or shorter than 12 characters, or while demo users would get the README password.

### Request pipeline

```
helmet → cors → json (raw body kept for webhook signatures) → access log (pino-http, request id) → contextMiddleware (ALS)
→ /api router → apiRateLimit → /api/health, /api/ready | module routers
→ authenticate (JWT → user, device, institute, branches, roles, permissions into context)
→ requirePermission('module','action') / requireModule('module') → handler (zod parse → service → TenantRepository)
→ errorHandler → { error: { code, message, details? } } (5xx also go to the error tracker)
```

The route registry (`infrastructure/route-registry.ts`) lists every mounted route with its module, authentication, permissions and rate limiters. The tests in `backend/test/security/` use it to probe every route (see CONTRIBUTING.md › Authorization and tenant-isolation suite).

### Health, logging and error tracking

- **Probes.**
  - `GET /api/health` is liveness: it answers 200 while the process runs and checks no dependency, so a database outage doesn't get the API restarted.
  - `GET /api/ready` is readiness: 200 only when the database answers, no migration is pending and storage is writable; 503 with the failed check otherwise. Load balancers and the Compose health check use it, so a release whose migrations haven't run takes no traffic.
  - Probe requests are not access-logged.
- **Logs.** pino writes one JSON object per line in production (pretty-printed in development) at `LOG_LEVEL`. Every entry made while handling a request or a job carries `requestId` and, once authenticated, `instituteId` and `userId`.
  - The request id comes from a client `X-Request-Id` when it is safe (`[\w.:-]{1,64}`), otherwise a new UUID, and is returned in the response header.
  - Authorization headers, cookies, passwords, API keys, tokens and OTPs are redacted, and so are the secrets in URLs (signed file and stream tokens, webhook keys).
- **Error tracking.** `ERROR_TRACKING_PROVIDER` (`none` by default) reports 5xx errors, failed jobs, unhandled rejections and startup crashes, with the request, institute and user ids but no request bodies:
  - `log` writes a structured `error_tracking` entry for log-based alerting;
  - `webhook` POSTs JSON events to `ERROR_TRACKING_WEBHOOK_URL`.

  A vendor SDK (Sentry, Rollbar…) plugs in as another `ErrorTracker` through `setErrorTracker()` in `infrastructure/error-tracking.ts`.

Deployment, TLS, backups and scaling are covered in [docs/deployment.md](docs/deployment.md) and [docs/backup-restore.md](docs/backup-restore.md); security controls and review findings in [docs/security.md](docs/security.md).

## Multi-tenancy

- **Ownership columns.** Every tenant-owned table has `institute_id`. Branch-owned data also has `branch_id`. Both are created with the `tenantColumns()` migration helper.
- **Where the tenant comes from.** The institute is taken from the verified access token only: `authenticate` puts it into context. Users with several memberships pick one via `POST /api/auth/select-institute`, which issues a new token. Clients never send an `instituteId`, and any value they send is ignored or overwritten.
- **Branch scope.** A user's allowed branches are either `user_branches`, or all branches when they hold an institute-wide role. The `X-Branch-Id` header narrows to one active branch and is validated against the allowed list.
- **`TenantRepository`** adds `instituteId` (and branch constraints) to every query, and overwrites `instituteId` on create. A row from another institute surfaces as **404**, never 403, so ids aren't leaked.
- **`registerTenantModel()` safety net.** It installs Sequelize hooks that **throw** on any find, count, bulk update or bulk destroy against a tenant model without an `instituteId` condition. Platform code must explicitly pass `{ tenantBypass: true }`.
- **Tenant model registry.** `listTenantModels()` enumerates every registered model, so institute export and deletion (`tenant-data`) cover each module's tables without extra wiring. Tables with an `institute_id` column that are not registered models are listed in `UNREGISTERED_INSTITUTE_TABLES` (`tenant-data/catalog.ts`). `test/tenant-data.test.ts` fails when a table is in neither.
- **Tests.** `backend/test/tenancy.test.ts` proves cross-tenant reads and writes and branch-restricted access are blocked.

## RBAC

- **Tables**: `permissions` (`module`, `action`, key `module.action`), `roles` (system or custom, per institute), `role_permissions`, `user_roles` (user × role × institute) and `user_branches`.
- **Actions**: `view | create | edit | delete | approve | export | publish | configure`.
- **System roles** are seeded and kept in sync: super-admin (platform flag), institute-admin (all permissions), branch-admin, accountant, teacher, student and parent.
- **Effective permissions** are the union across all of a user's roles in the current institute. They are loaded per request.
- **Super admin** (`users.is_super_admin`) bypasses permission checks on platform routes. Inside an institute it acts only through **impersonation**, which issues a short-lived token marked `impersonatedBy`. Impersonation start and stop are audited, and audit events carry `impersonator_id`.

## Auth and devices

- **Login methods:** password, or OTP (6 digits, hashed, TTL and attempt limits).
- **Tokens:** access JWT of 15 minutes. Refresh tokens are opaque, stored as a sha256 hash, rotated on every refresh, and bound to a device.
- **Devices:**
  - A device is identified by a client-generated id (Capacitor `Device.getId()`) plus its platform.
  - At most **2 active devices** per user (`MAX_ACTIVE_DEVICES`).
  - A user's first device is trusted. Any further new device must pass OTP.
  - When the limit is reached, login returns `device_limit_reached` with the active device list.
- **Device sessions** (spec 4.18): every authenticated request checks the device row, so a revoked device gets 401 `SESSION_REVOKED` at once (its unexpired access tokens included) and a deactivated account gets `ACCOUNT_INACTIVE`.
- **Revoking a device:**
  - Users: their own devices, `GET`/`DELETE /auth/devices`.
  - Institute admins: `GET /users/devices` (members with sign-ins), `GET /users/:id/devices`, `DELETE /users/:id/devices/:deviceId` (`users.view` to list, `users.edit` to revoke). Institute-wide admins manage any member. Branch admins manage only members limited to branches they share. Anyone else (institute-wide members for a branch admin, super-admin accounts, other institutes' users) is 404.
  - Super admin: anyone, `GET /admin/users?search=`, `GET /admin/users/:id/devices`, `DELETE /admin/users/:id/devices/:deviceId`.
  - Revoking ends the device's refresh tokens and biometric unlock, is audited (`device.revoked`), notifies the user when an admin did it, and emits `onDeviceRevoked` (`authentication/api`): LMS revokes the device's offline licences, notifications drop its push tokens.
- **Inactivity logout:**
  - Institute setting `security.idle_timeout_minutes` (Institute profile → Security; 0 = never, 5–1440; `GET/PATCH /institute` field `idleTimeoutMinutes`). `SESSION_IDLE_TIMEOUT_MINUTES` (default 0) applies to institutes without the setting and to sessions without an institute.
  - The device's `lastSeenAt` is the last user activity: any request except background polls (`X-Background-Request: 1`), plus the app's heartbeat `POST /auth/activity`. After the timeout, requests and `/auth/refresh` return 401 `SESSION_IDLE` (`shared/session-policy.ts`). Impersonation tokens have their own expiry and are exempt.
  - The app enforces the same timeout on its own timer (`core/idle.ts`) and when it resumes.
- **Biometric unlock** (app only, opt-in after a full sign-in): `POST /auth/biometric` returns a device-bound secret. The server keeps only its hash; the app keeps it in the Keychain / Keystore behind the OS biometric prompt. `POST /auth/biometric/unlock` exchanges it for a new session on the same device and revokes the device's older refresh tokens. Sign-out, revocation and `DELETE /auth/biometric` turn it off; password and OTP always work.

## Platform services available to modules

| Need                             | Use                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit trail                      | `audit({ action: 'students.create', entityType, entityId, before?, after?, metadata? })` from `shared/audit/audit.service` (context adds actor, institute, IP, impersonator)                                                                                                |
| Validation                       | `parse(zodSchema, req.body)` from `shared/utilities/validation` → 400 `VALIDATION_ERROR` with `details: [{path,message}]`                                                                                                                                                   |
| Errors                           | `BadRequest`, `Forbidden`, `NotFound`, `Conflict`, `LimitExceeded`, `AppError` from `shared/errors`                                                                                                                                                                         |
| Plan limits                      | `assertWithinLimit(instituteId, 'maxStudents', currentCount)`; `requireModule('<module>')` route gate                                                                                                                                                                       |
| Files                            | `saveUploadedFile({...})`, `signedUrlFor(file)`, `deleteFile(id)` from `modules/files/files.service`; storage path `institutes/<id>/<yyyy>/<mm>/<uuid><ext>`                                                                                                                |
| AI                               | `aiChat({ feature: 'exams.generate', messages, jsonMode? })` from `modules/ai/ai.service` (quota check, provider call, `ai_usage` metering incl. images and cost)                                                                                                           |
| Background jobs                  | `enqueueJob('module.job-name', payload, { runAt? })`; handlers declared in the module's `jobs` map; run with tenant context. Running jobs heartbeat their lock; stale `running` jobs are reclaimed on boot and every minute; `registerJobFailureHandler` for final failures |
| Notifications (all channels)     | `notify({ event, recipients, data })` from `modules/notifications/api`: rules → templates → preferences → queued delivery with retries (see CONTRIBUTING.md)                                                                                                                |
| SMS/WhatsApp/email/push          | Low-level `getMessagingProvider(channel)`; platform/auth code only (OTP). Per-institute providers via `createMessagingProvider()`                                                                                                                                           |
| Payments / streaming / biometric | `getPaymentGateway(instituteId)`, `infrastructure/streaming`, `infrastructure/biometric` (mock implementations)                                                                                                                                                             |
| Calendar / online meetings       | `getCalendarProvider(instituteId)` from `infrastructure/calendar`: create/update/cancel events and get a meeting link (mock implementation)                                                                                                                                 |
| Parent portal                    | `registerParentPortalProvider()` from `modules/parent-portal/api` (backend sections); app `widgets` with slot `parent-home` (see CONTRIBUTING.md)                                                                                                                           |
| Reports / analytics              | module `reporting.ts` queries take a `ReportScope` (`shared/reporting.ts`); `setSaasBillingStatsProvider()` in `modules/reports/api`; widget slots `home`, `platform-home`                                                                                                  |

## Files

- Uploads go to `POST /api/files` (multipart `file`, `module`, optional `branchId`). Size limit is `MAX_UPLOAD_MB`, plus the plan storage quota.
- Bytes are stored by the active `StorageAdapter`. The super admin picks the driver under Integrations → Storage. `local` (under `backend/storage/`) is implemented; the S3/R2 adapter is a stub for later.
- Metadata goes to `files`.
- Downloads use `GET /api/files/:id/url`, which returns a signed URL that is HMAC-signed and expires after `SIGNED_URL_TTL_SECONDS`. That URL is served by `/api/files/signed/:token`, which supports Range requests for video. Files are never served from a public static directory.
- **Serving policy** (`shared/utilities/file-response.ts`). Uploads are served from the API origin with a type the client declared, so the type isn't trusted:
  - images, video, audio and PDF are shown inline with their type, and text as `text/plain`; anything else is downloaded as `application/octet-stream`;
  - every response has `nosniff`, and everything but media and PDF gets a sandbox CSP, so an SVG opened directly can't run script;
  - HTML, XHTML and executables are refused at upload.

  Call `setFileResponseHeaders()` from that file in any route that streams an upload (logos, website media).

## AI configuration

- **Storage.** `ai_settings` is a singleton platform row holding provider, base URL, model, JSON mode, optional prices (`inputUsdPer1M`, `outputUsdPer1M`) and an encrypted key. The key is AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- **Defaults.** Env `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY` apply until a super admin saves settings.
- **Key handling.** The API returns only `keyHint` (for example `AQ….Sf9Q`) and `keySource` (`database | env | none`). An empty key on save keeps the existing one; `DELETE /api/admin/ai/settings/key` removes it.
- **Test connection.** `POST /api/admin/ai/settings/test` makes a tiny chat-completions call with the unsaved form values, falling back to the stored key.
- **Mock provider.** `infrastructure/ai-providers/mock.client.ts` is a deterministic, offline provider for development and tests. It returns the same output for the same input:
  - Grading prompts are marked by keyword overlap of the answer (typed text plus simulated OCR) with the model answer and rubric, in the grading JSON format.
  - Question generation returns well-formed sample questions of the requested type. Other chats get a short fixed reply.
  - Simulated OCR reads text from PNG `tEXt`/`iTXt`/`zTXt` chunks or JPEG comments, so tests can attach "handwritten" pages with known content.
  - Usage is reported like a real provider (about 4 characters per token, 765 tokens per image) and priced at the mock preset's list price, so quotas and cost tracking work.
  - A message containing `[[mock:fail]]` fails like a provider error (for tests).
- **When the mock is used.** Only outside production:
  - when a super admin selects it (`mockAllowed` in the settings);
  - or, while the configured provider has no key, as the fallback (`AI_MOCK_FALLBACK`, default `true`). Settings then report `effectiveProvider: 'mock'` and `mockReason: 'fallback'`.

  In production the mock can't be saved (400 `MOCK_AI_NOT_ALLOWED`) or run (503 `AI_NOT_CONFIGURED`). A configured real provider is never replaced by the mock, and provider errors never fall back to it.

- **Usage metering.** Every `aiChat()` call writes `ai_usage`:
  - institute, user and feature;
  - provider and model;
  - prompt and completion tokens, and image count;
  - estimated cost in USD;
  - latency and status.

  Cost uses the prices saved in settings, else the preset's list price when the preset model is in use (`pricingSource`). The quota is the effective `aiTokensMonthly` limit (see SaaS billing → Limits), counted per calendar month in the institute timezone and checked before each call (429 `AI_QUOTA_EXCEEDED`). `GET /api/ai/usage` (institute, `ai.view`) and `GET /api/admin/ai/usage` (platform, per institute and per provider) summarise it.

- **AI grading (exams).** An exam's `evaluationMode` is one of:
  - `manual`;
  - `ai_assist`: the AI suggests marks, and a teacher accepts or overrides them;
  - `ai_only`: AI marks are final; choosing it needs `exams.configure`.

  The AI modes need AI in the plan. Grading runs as a job through `aiChat({ feature: 'exams.grading' })`. `grading_jobs` and `grading_results` record provider, model, tokens, images, estimated cost, latency and the `ai_usage` row.

  The student's answer is never modified. Every AI result, teacher edit, correction and publish/unpublish snapshot appends to `exam_mark_revisions`; `GET /api/exams/:id/evaluations/:answerId/history` returns them. `GET /api/exams/ai-status` shows the provider, whether it is the mock and the remaining quota.

  When the quota runs out or AI isn't configured, the job stops (audit `exam.ai_grading_stopped`) and the remaining answers stay pending for manual marking.

## SaaS billing (`subscriptions`)

- **Lifecycle.** A subscription goes trial → active → grace → restricted (read-only) → suspended. The access state is computed from the subscription dates and the super admin's billing policy (`/api/admin/billing/settings/policy`: grace days, trial grace days, the after-grace mode, days until suspension, renewal lead days and invoice due days).
- **Sweep.** The hourly `subscriptions.billing-sweep` job does four things:
  - issues renewal invoices `renewalLeadDays` before expiry;
  - stores daily usage snapshots (students, branches, teachers, storage, AI tokens) and invoices overage at plan pricing;
  - syncs stored statuses;
  - notifies institute admins once per state and term.
- **Plan changes and add-ons.**
  - Upgrades are invoiced prorated and applied once paid.
  - Downgrades are scheduled for the end of the period.
  - Add-ons cover extra students, branches, teachers, storage, AI credits and modules. Recurring packs are prorated to the period end. AI credits count only in the month they were bought.
- **Limits.** `getPlanLimits()` returns the plan limits plus the super admin's overrides, active add-ons and the plan's overage allowance. `assertWithinLimit` and the AI quota both enforce these limits.
- **Invoices.**
  - Numbering is `SAAS/<financial year>/<6 digits>` from a global counter; numbers are never reused.
  - GST uses the operator profile (`/api/admin/billing/settings/profile`: GSTIN, address, state). Supply within one state is taxed CGST + SGST, otherwise IGST.
  - PDFs are shared through short-lived signed `/api/subscriptions/public/documents/:token` links.
- **Payments.**
  - Payments go through the `infrastructure/payment-gateways` adapters with the super admin's gateway.
  - Webhooks arrive at `POST /api/subscriptions/public/webhooks/:gateway`. They are signature-verified and idempotent per gateway event id.
  - Super admins record manual payments and adjustments and issue credit notes.
- **Enforcement.** `subscriptionAccessGuard` is registered with `addTenantRequestGuard` and answers **402**:
  - `SUBSCRIPTION_RESTRICTED` for writes while restricted;
  - `SUBSCRIPTION_SUSPENDED` while suspended, for everything except `/api/auth`, `/api/subscription`, `/api/tenant-data` and the member device routes (`/api/users/devices`, `/api/users/:id/devices[/:deviceId]`), which stay open in every state so a lost device can always be signed out.
  - Super admins, including while impersonating, are never blocked.
- **Reports.** `subscriptions/api.ts` exports `revenueByMonth`, `subscriptionsByState`, `subscriptionsByPlan`, `saasBillingKpis` and `usageSummary` for the SaaS-wide dashboard.

## Global integrations (`platform`)

- **Storage of settings.** `platform_integrations` holds the super admin's payment gateways, notification providers (SMS, WhatsApp, email, push) and file storage. Secrets are AES-256-GCM encrypted with `ENCRYPTION_KEY`, as AI keys are, and the API returns only hints.
- **Precedence.** Institute settings come first. An institute's own fee gateway or notification provider is used when it has one; the global configuration is the fallback (`setPlatformFeesGatewayProvider`, `setDefaultMessagingResolver`). SaaS subscription payments always use the global gateways (`setSaasGatewayResolver`). The wiring lives in `platform/integrations.ts`.
- **Storage driver.** The chosen storage driver is applied to each API and worker process with `setStorage()` and refreshed every 60 seconds.

## Institute data (`tenant-data`)

- **Export.**
  - Institute admins (`tenant-data.export`) or super admins queue the `tenant-data.export` job.
  - It builds one zip with every tenant table as JSON and CSV plus the institute's files. Credentials, tokens and hashes are never exported.
  - Downloads use a signed link valid for 10 minutes. The archive is deleted after 7 days.
- **Deletion.**
  1. An institute admin requests it (`tenant-data.delete`) and confirms with the institute code.
  2. A super admin approves it with a grace period (30 days by default). Approval deactivates the institute.
  3. Once the grace period ends, `tenant-data.sweep` queues `tenant-data.purge`. The purge deletes every tenant row and the institute's stored files. It is idempotent and can be retried.

  Rows registered with `retainOnInstituteDeletion` (the operator's SaaS invoices, payments and credit notes) are kept with `institute_id` set to NULL. Every step is audited. An institute reactivated during the grace period is never deleted.

## Frontend app

```
app/src/
  main.ts App.vue          # Ionic shell: split-pane menu, branch switcher, impersonation banner
  core/                    # api client, secure storage + token storage, device id, branding, module registry,
                           # v-can directive, toast, session (lock / sign-out), idle monitor, biometric, secure screens
  stores/auth.ts           # session, memberships, permissions: can('module.action'), moduleEnabled()
  router/index.ts          # collects routes from modules; guards: auth, institute selection, meta.permission, meta.superAdmin
  components/              # AppPage, StatCard, ImpersonationBanner, ...
  modules/<name>/module.ts # defineAppModule({ id, routes, menu, toolbarItems }), auto-discovered with import.meta.glob
```

- **API client** (`core/api.ts`): adds the Bearer token and `X-Branch-Id`. On a 401 it refreshes once (single-flight) and retries. If the refresh fails, the session ends. `SESSION_IDLE`, `SESSION_REVOKED` and `ACCOUNT_INACTIVE` end it without a refresh. `core/session.ts` then locks the app when biometric unlock is set up, unless the device was revoked or the account deactivated, and otherwise signs out. A revoked device or deactivated account also runs every module's `wipeUserData`. Pass `{ background: true }` for automatic polls.
- **Branding**: after institute selection, `applyBranding()` sets the Ionic `--ion-color-primary/secondary` variants and the document title from the institute's settings. The logo is shown in the menu header.
- **Menu**: built from every module's `menu` items, filtered by `permission`, `superAdmin` and `planModule` (whether the institute's plan includes the module).
- **Subscription state**:
  - The subscriptions module adds a toolbar chip for the trial, grace, restricted and suspended states.
  - Through its `navigationGuards` entry, a suspended institute can only open routes with `meta.allowWhenSuspended`.
  - `setPaymentRequiredHandler()` in `core/api.ts` hands it every 402 (JSON calls and `api.download()` alike), so the state refreshes as soon as the API starts refusing.
  - Order of the API's checks: user active → device revoked (401 `SESSION_REVOKED`) → idle (401 `SESSION_IDLE`) → institute/membership (403) → branch → tenant guards (402). A revoked or idle device is signed out even while the institute is suspended. Live-class sockets run the same checks at the handshake, as reads (allowed while restricted, refused while suspended), and a device sign-out drops its open sockets.
  - `stores/auth.ts` `init()` clears the stored session only on a 401; network errors and 5xx keep it (offline mode).
- **Native apps**: the same build runs in Capacitor (`app/android`, `app/ios`). Device provides the device id.
  - Tokens, the cached profile, offline content keys and the biometric credential live in secure storage (`core/secure-storage.ts`: iOS Keychain, Android Keystore-backed AES-GCM), never plain preferences. The web build uses localStorage.
  - iOS uses Swift Package Manager (`ios/App/CapApp-SPM`, written by `cap sync`): every plugin must ship a `Package.swift`. Android `minSdkVersion` is 26 (required by the QR scanner).

## Mobile and device security (spec 4.18) and platform limits (spec 9)

**Protected screens.** Screens opt in with `<SecureView screen="…">` (`app/src/components/SecureView.vue`), so ordinary screens are unaffected. Protected today: `lms-content` (lecture player), `live-class` (students in a live room), `live-recording`, `exam-attempt`, `exam-result`, `question-paper` and `question-bank`. While a protected screen is shown:

- A **dynamic watermark** is tiled over the content: the viewer's name and mobile number plus the current time, drifting every few seconds.
- **Capture restrictions** apply as far as the platform allows (`core/secure-screen.ts`). The privacy-screen plugin is off by default and is turned on only while a protected screen is shown.
  - Android: `FLAG_SECURE` (`@capacitor-community/privacy-screen`). Screenshots, recordings and casting come out black, and the app switcher shows a blank card.
  - iOS: capture cannot be blocked. Recording, mirroring and AirPlay are detected (app-local `ScreenCapture` plugin) and the content is shielded until they stop. Screenshots are detected after they are taken, and the user is warned. Both are reported to `POST /auth/capture-events` and audited as `device.screenshot_detected` / `device.recording_detected` with the screen names. The privacy screen replaces the app-switcher snapshot.
  - Web: capture can be neither blocked nor detected. The watermark is the only deterrent.

**Offline content** (LMS downloads, app only):

- A download needs an unlocked entitlement for an offline-enabled lecture and an offline licence bound to the device (app only). The licence lasts the lecture's offline hours, capped by the learner's access. The copy is encrypted with AES-256-GCM and its key is kept in secure storage.
- Each copy belongs to the account that downloaded it. Signing out keeps downloads, but no other account on the device can see or delete them.
- When online, a copy's licence is checked with the server (server time) before it plays, and when the offline list or the library opens. The server revokes licences whose access ended or whose lecture was unpublished or is no longer offline-enabled; the app deletes copies whose licence was revoked or has expired.
- Revoking a device revokes its licences. The app deletes the user's copies as soon as it hears of it (401 `SESSION_REVOKED` or `ACCOUNT_INACTIVE` runs every module's `wipeUserData`).

**Limits** that no app can remove (spec 9). Document them for institutes rather than promise more:

- Nothing stops a second camera pointed at the screen; the watermark identifies the source.
- iOS cannot prevent screenshots, only detect them after the fact. iOS's native full-screen video player hides the watermark: the shield takes the player out of full screen when a recording starts. `preventScreenshots` of the privacy-screen plugin has no effect with a scene delegate.
- Rooted or jailbroken devices can get around these protections, `FLAG_SECURE` included.
- A revoked device that stays offline keeps playing its downloads until it reconnects or the licence expires. Offline, expiry relies on the device clock. Setting the clock more than 10 minutes behind a time the app has already seen is detected, and copies stay locked until a check with the server succeeds; that check also replaces the time seen, so a clock that was wrongly set ahead cannot lock copies for good. A device kept offline with its clock held back while the app is closed, or already behind at its last successful check, can still play past expiry.
- Biometric unlock reopens the session of the last user who turned it on for that device. Another user signs in with a password or OTP.
- The web app relies on the watermark, short access tokens and the server-side inactivity timeout.

**QR check-in** uses `@capacitor/barcode-scanner` (Swift Package Manager on iOS, bundled ML Kit on Android). `@capacitor-mlkit/barcode-scanning` was dropped because it has no SPM support. The web build keeps the browser camera / manual code fallback.
