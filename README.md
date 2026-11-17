# ERP Coaching

This is a multi-tenant SaaS ERP for coaching institutes. It ships as one codebase with three parts:

- **API**: Node.js, Express 5, Sequelize 6 and MySQL 8, written in TypeScript.
- **Web portal plus iOS and Android apps**: one Vue 3 + Ionic + Capacitor app.
- **Shared types**: `packages/shared`.

```
backend/          Express API (modular monolith): src/modules/*, src/infrastructure/*, src/shared/*
app/              Vue 3 + Ionic + Capacitor app (web, android/, ios/)
packages/shared/  TypeScript types/constants shared by API and app (@erp/shared)
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) for how the platform works. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions every feature module **must** follow.

## Prerequisites

- Node.js 22+ and npm 10+.
- MySQL 8, installed locally. Docker is not needed.
- For mobile builds:
  - Android: Android Studio (SDK and emulator).
  - iOS: Xcode 16+ on macOS. CocoaPods is not required because Capacitor 8 uses Swift Package Manager.

## 1. Create the MySQL databases

```sql
-- mysql -u root -p
CREATE DATABASE erp_coaching      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE erp_coaching_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'erp_dev'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON erp_coaching.*      TO 'erp_dev'@'localhost';
GRANT ALL PRIVILEGES ON erp_coaching_test.* TO 'erp_dev'@'localhost';
FLUSH PRIVILEGES;
```

The test suite drops and recreates `erp_coaching_test` on every run, so never point `TEST_DB_NAME` at real data.

## 2. Configure and install

```bash
cp backend/.env.example backend/.env   # set DB_PASSWORD; generate secrets as described in the file
cp app/.env.example app/.env           # VITE_API_URL (default http://localhost:4000)
npm install                            # installs all workspaces and builds @erp/shared
```

In development, `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY` and `FILE_URL_SECRET` fall back to insecure defaults. In production they are **required**.

## 3. Migrate and seed

```bash
npm run db:migrate    # core migrations plus every module's migrations, in timestamp order
npm run db:seed       # permissions, system roles, plans, super admin and 2 demo institutes
# npm run db:reset    # drop, recreate, migrate and seed
```

## 4. Run

```bash
npm run dev:api       # http://localhost:4000  (GET /api/health)
npm run dev:app       # http://localhost:5173
```

### Demo logins

| Who                                                                                     | Mobile                      | Password       |
| --------------------------------------------------------------------------------------- | --------------------------- | -------------- |
| Platform Super Admin                                                                    | `9000000000`                | `Admin@12345`  |
| Apex Coaching: Institute Admin / Branch Admin / Accountant / Teacher / Student / Parent | `9100000001` … `9100000006` | `Password@123` |
| Zenith Academy: same roles                                                              | `9200000001` … `9200000006` | `Password@123` |

**OTP in dev.** Two cases ask for an OTP: OTP login, and the first login from a _new_ device when the user already has one. SMS uses a console adapter, so the code is printed in the API log as `[DEV] OTP for <mobile>: 123456`. Each user can have at most 2 active devices; revoke one under **My devices**.

## Tests, lint, build

```bash
npm test              # backend integration tests (real MySQL test DB) + app unit tests
npm run typecheck
npm run lint
npm run build         # shared → backend (dist/) → app (dist/)
```

## Mobile (Capacitor)

```bash
npm run build -w app
npm run cap:sync -w app                  # copy web build plus plugins into android/ and ios/
cd app && npx cap open android           # or: npx cap open ios
```

The app reads the API URL at **build time** from `VITE_API_URL` in `app/.env`:

- **Android emulator**: `VITE_API_URL=http://10.0.2.2:4000`.
- **iOS simulator**: `http://localhost:4000` works.
- **Real device**: use your machine's LAN IP, for example `http://192.168.1.20:4000`.

Rebuild and run `cap:sync` after changing it.

Native webview origins (`capacitor://localhost`, `https://localhost`) are already in the backend `CORS_ORIGINS`. Cleartext HTTP is allowed only in non-production builds (see `app/capacitor.config.ts`). iOS allows local networking; plain HTTP to a LAN IP may still need an ATS exception in `ios/App/App/Info.plist`.

## What the platform foundation includes

- **Auth**
  - Mobile + password login, and mobile + OTP login.
  - JWT access tokens, plus rotating refresh tokens stored hashed.
  - Device registration capped at 2 active devices, with OTP required on a new device.
- **Multi-tenancy**
  - Tables: institutes, branches and institute settings.
  - The tenant is resolved only from the token.
  - A tenant-scoped repository plus Sequelize hooks block cross-tenant reads and writes. Tests prove this.
- **RBAC**
  - Roles, permissions (`module.action`), multiple roles per user, custom roles and branch assignment.
  - Backend middleware: `requirePermission('module','action')`.
  - Frontend: the `v-can` directive and route guards.
- **Super Admin**
  - Institute CRUD, activate and suspend.
  - Plans with limits (students, branches, teachers, storage, AI tokens, modules) and subscriptions.
  - Audited impersonation.
- **Platform services**
  - Audit log, zod validation, consistent error shape, rate limiting, helmet, and a DB-backed background job queue.
- **Files**
  - A storage adapter (local disk now; S3/R2 stub) with tenant-scoped paths.
  - Short-lived HMAC-signed download URLs, and a plan storage quota.
- **AI**
  - An OpenAI-compatible provider configuration screen with presets: OpenAI, Azure, Gemini, Groq, OpenRouter and Ollama.
  - The key is encrypted at rest (AES-256-GCM) and never returned to the browser.
  - Test connection, plus an `aiChat()` service with per-institute usage metering and quota (`ai_usage`).
- **Integrations**: adapter interfaces with console or mock implementations for SMS, WhatsApp, email, push, payments, live streaming and biometric devices.
- **App shell**
  - Login, OTP and institute selection.
  - Dynamic institute branding (logo and colours) and a branch switcher.
  - A role-aware menu built from auto-discovered modules.
  - Super Admin screens for institutes, plans, AI configuration and the audit log.
