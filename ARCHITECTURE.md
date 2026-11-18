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
| Reports / analytics              | module `reporting.ts` queries take a `ReportScope` (`shared/reporting.ts`); `setSaasBillingStatsProvider()` in `modules/reports/api`; widget slots `home`, `platform-home`   |

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
  core/                    # api client, token storage (Capacitor Preferences), device id, branding,
                           # module registry, v-can directive, toast
  stores/auth.ts           # session, memberships, permissions: can('module.action'), moduleEnabled()
  router/index.ts          # collects routes from modules; guards: auth, institute selection, meta.permission, meta.superAdmin
  components/              # AppPage, StatCard, ImpersonationBanner, ...
  modules/<name>/module.ts # defineAppModule({ id, routes, menu, toolbarItems }), auto-discovered with import.meta.glob
```

- **API client** (`core/api.ts`): adds the Bearer token and `X-Branch-Id`. On a 401 it refreshes once (single-flight) and retries. If the refresh fails, the session is cleared.
- **Branding**: after institute selection, `applyBranding()` sets the Ionic `--ion-color-primary/secondary` variants and the document title from the institute's settings. The logo is shown in the menu header.
- **Menu**: built from every module's `menu` items, filtered by `permission`, `superAdmin` and `planModule` (whether the institute's plan includes the module).
- **Native apps**: the same build runs in Capacitor (`app/android`, `app/ios`). Preferences hold tokens; Device provides the device id.
