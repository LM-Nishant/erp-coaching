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
    authentication users permissions institutes branches subscriptions files ai audit
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

### Request pipeline

```
helmet → cors → json → contextMiddleware (request id, ALS) → rate limit
→ /api router → authenticate (JWT → user, device, institute, branches, roles, permissions into context)
→ requirePermission('module','action') / requireModule('module') → handler (zod parse → service → TenantRepository)
→ errorHandler → { error: { code, message, details? } }
```

## Multi-tenancy

- **Ownership columns.** Every tenant-owned table has `institute_id`. Branch-owned data also has `branch_id`. Both are created with the `tenantColumns()` migration helper.
- **Where the tenant comes from.** The institute is taken from the verified access token only: `authenticate` puts it into context. Users with several memberships pick one via `POST /api/auth/select-institute`, which issues a new token. Clients never send an `instituteId`, and any value they send is ignored or overwritten.
- **Branch scope.** A user's allowed branches are either `user_branches`, or all branches when they hold an institute-wide role. The `X-Branch-Id` header narrows to one active branch and is validated against the allowed list.
- **`TenantRepository`** adds `instituteId` (and branch constraints) to every query, and overwrites `instituteId` on create. A row from another institute surfaces as **404**, never 403, so ids aren't leaked.
- **`registerTenantModel()` safety net.** It installs Sequelize hooks that **throw** on any find, count, bulk update or bulk destroy against a tenant model without an `instituteId` condition. Platform code must explicitly pass `{ tenantBypass: true }`.
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

| Need                             | Use                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit trail                      | `audit({ action: 'students.create', entityType, entityId, before?, after?, metadata? })` from `shared/audit/audit.service` (context adds actor, institute, IP, impersonator) |
| Validation                       | `parse(zodSchema, req.body)` from `shared/utilities/validation` → 400 `VALIDATION_ERROR` with `details: [{path,message}]`                                                    |
| Errors                           | `BadRequest`, `Forbidden`, `NotFound`, `Conflict`, `LimitExceeded`, `AppError` from `shared/errors`                                                                          |
| Plan limits                      | `assertWithinLimit(instituteId, 'maxStudents', currentCount)`; `requireModule('<module>')` route gate                                                                        |
| Files                            | `saveUploadedFile({...})`, `signedUrlFor(file)`, `deleteFile(id)` from `modules/files/files.service`; storage path `institutes/<id>/<yyyy>/<mm>/<uuid><ext>`                 |
| AI                               | `aiChat({ feature: 'exams.generate', messages, jsonMode? })` from `modules/ai/ai.service` (quota check, provider call, `ai_usage` metering)                                  |
| Background jobs                  | `enqueueJob('module.job-name', payload, { runAt? })`; handlers declared in the module's `jobs` map; run with tenant context                                                  |
| Notifications (all channels)     | `notify({ event, recipients, data })` from `modules/notifications/api`: rules → templates → preferences → queued delivery with retries (see CONTRIBUTING.md)                 |
| SMS/WhatsApp/email/push          | Low-level `getMessagingProvider(channel)`; platform/auth code only (OTP). Per-institute providers via `createMessagingProvider()`                                            |
| Payments / streaming / biometric | `getPaymentGateway(instituteId)`, `infrastructure/streaming`, `infrastructure/biometric` (mock implementations)                                                              |
| Calendar / online meetings       | `getCalendarProvider(instituteId)` from `infrastructure/calendar`: create/update/cancel events and get a meeting link (mock implementation)                                  |
| Parent portal                    | `registerParentPortalProvider()` from `modules/parent-portal/api` (backend sections); app `widgets` with slot `parent-home` (see CONTRIBUTING.md)                            |

## Files

- Uploads go to `POST /api/files` (multipart `file`, `module`, optional `branchId`). Size limit is `MAX_UPLOAD_MB`, plus the plan storage quota.
- Bytes are stored by the active `StorageAdapter`. That is `local` (under `backend/storage/`) today; an `s3` stub covers S3/R2 later.
- Metadata goes to `files`.
- Downloads use `GET /api/files/:id/url`, which returns a signed URL that is HMAC-signed and expires after `SIGNED_URL_TTL_SECONDS`. That URL is served by `/api/files/signed/:token`, which supports Range requests for video. Files are never served from a public static directory.

## AI configuration

- **Storage.** `ai_settings` is a singleton platform row holding provider, base URL, model, JSON mode and an encrypted key. The key is AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- **Defaults.** Env `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY` apply until a super admin saves settings.
- **Key handling.** The API returns only `keyHint` (for example `AQ….Sf9Q`) and `keySource` (`database | env | none`). An empty key on save keeps the existing one; `DELETE /api/admin/ai/settings/key` removes it.
- **Test connection.** `POST /api/admin/ai/settings/test` makes a tiny chat-completions call with the unsaved form values, falling back to the stored key.
- **Usage metering.** Every `aiChat()` call writes `ai_usage` (institute, user, feature, tokens, latency, status). The quota comes from the plan's `aiTokensMonthly` limit.

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
