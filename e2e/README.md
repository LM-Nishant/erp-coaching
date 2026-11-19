# @erp/e2e — browser end-to-end tests

Playwright tests that drive the real web app (Vite dev server) against the real API and a MySQL
database. They cover the critical workflows of spec §7. Setup that isn't the point of a test goes
through the API; the steps a user cares about (signing in, paying, booking, seeing a result,
sending an enquiry) are driven in the browser.

## What it covers

| Spec (`tests/`)                   | Workflow                                                  | In the browser                                                                                                                               |
| --------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `otp-login-device-limit.spec.ts`  | OTP login and the device limit (`MAX_ACTIVE_DEVICES` = 2) | OTP sign-in on device 1; password plus new-device OTP on device 2; device 3 refused (password and OTP); "My devices" sign-out frees a slot   |
| `admission-payment-lms.spec.ts`   | Admission → fee payment (mock gateway) → LMS access       | Admin edits the application, then admits into its batch. Student signs in, finds the paid lecture locked, pays (declined, then OK), opens it |
| `attendance-absent-alert.spec.ts` | Attendance marked absent → parent alert                   | Teacher marks P/A, saves and closes the session (the rest are marked absent). Parent sees "Absent today" in notifications                    |
| `exam-results-parent.spec.ts`     | Exam → auto-scored attempt → publication → parent portal  | Student takes the MCQ exam. Admin checks the auto score and publishes. Parent sees 8 / 12 (passed) and opens the result                      |
| `appointment-booking.spec.ts`     | Parent-teacher appointment                                | Parent requests a 16:00 slot. Teacher approves it from Pending with a note. Parent sees the confirmation, note, history and notification     |
| `website-enquiry.spec.ts`         | Website publish → enquiry → lead                          | Admin publishes the site. A visitor submits the public enquiry form. Staff find the enquiry in Admissions                                    |
| `live-class.spec.ts`              | Live class → notification → join → recording in the LMS   | Teacher schedules and goes live. Student sees the notification and joins: chat, Q&A, poll, mic allowed. Recording listed, opened in the LMS  |
| `academic-promotion-fees.spec.ts` | Academic promotion → new-session fees                     | Admin promotes a batch into the next session with "Apply new-session fees" on and a due date. Sees 2 promoted and billed, 1 already enrolled |

Each spec also checks the server-side outcome where it matters, for example:

- the SMS sent to parents (dev outbox);
- no message to a present student's parent;
- an idempotent replay of the gateway's signed payment result;
- the fee balance.

## Running locally

You need Node 22, a MySQL 8 server and a database user that can create and drop the E2E database
(see [Environment](#environment)).

```sh
npm install              # once, at the repo root
npm run e2e:install      # once: downloads Playwright's Chromium
npm run e2e              # from the repo root: starts the API and web servers, runs every spec
```

From `e2e/` you can also use the Playwright CLI directly:

```sh
npx playwright test tests/website-enquiry.spec.ts   # one spec
npx playwright test --headed                        # or --ui / --debug
npx playwright test --repeat-each=2                 # check a spec is repeatable
npm run report                                      # open the last HTML report
```

When iterating, keep the servers running in two terminals; Playwright reuses them locally (never
on CI):

```sh
npm run serve:api -w @erp/e2e   # resets the E2E database, then runs the API on :4105
npm run serve:web -w @erp/e2e   # Vite on :5205, pointed at the E2E API
```

Restart `serve:api` to get a fresh database. Any process listening on 4105/5205 is reused, so
don't point another API at those ports.

## How it works

- **Servers.** `webServer` in `playwright.config.ts` runs `scripts/start-api.ts` and
  `scripts/start-web.ts`.
  - The API script wipes `e2e/.tmp`, then runs the backend database CLI: `create`, then `reset`.
    The reset drops all tables, migrates and seeds the super admin, the plans and demo data, which
    no spec relies on.
  - It then runs `backend/src/server.ts` with tsx, without watch mode.
  - The web script runs the app's Vite dev server with `VITE_API_URL=http://localhost:4105`.
  - `global-setup.ts` checks `/api/health` and warms up Vite, so the first spec doesn't pay for
    compiling the app.
- **Database.** Every run starts from a freshly reset `E2E_DB_NAME`. The name must contain `e2e`,
  because the reset drops every table. No other database is touched.
- **Backend settings are pinned** (`apiServerEnv()` in `support/env.ts`), so a local run behaves
  like CI.
  - Every setting in `backend/.env` except the DB connection is blanked, so the backend uses its
    defaults.
  - `NODE_ENV=development`.
  - The jobs worker is on, polling every 500 ms.
  - Rate limiting is off and `MAX_ACTIVE_DEVICES=2`.
  - SMS, WhatsApp, email and push use the `console` providers.
  - `PAYMENT_GATEWAY=mock`, with mock streaming and biometric providers.
  - Uploads go to local storage in `e2e/.tmp/storage`.
- **Outbox.** The console providers append each SMS, WhatsApp, email or push message to
  `DEV_OUTBOX_FILE` = `e2e/.tmp/outbox.jsonl`, one JSON object per line. `support/outbox.ts` reads
  it; that is how specs get login OTPs and check parent alerts. Specs run one at a time
  (`workers: 1`) and every user has a unique mobile, so filtering by recipient after an
  `outboxMark()` is reliable.
- **Browser.** Desktop Chrome with timezone `Asia/Kolkata` (the institutes' default zone) and
  locale `en-IN`. Each browser context is a new device for the app.
- **Outputs** (all gitignored):
  - `e2e/test-results/`: trace, screenshot and `error-context.md` for each failed test;
  - `e2e/playwright-report/`: the HTML report;
  - `e2e/.tmp/`: outbox and uploads.
- **CI mode** (`CI` set):
  - `forbidOnly`;
  - 1 retry;
  - GitHub annotations;
  - servers are never reused;
  - a 20-minute global timeout.

## Environment

| Variable                                       | Default                               | Purpose                                                                                                       |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | `backend/.env`, then backend defaults | MySQL connection for the API and the database reset                                                           |
| `TEST_DB_NAME`                                 | `backend/.env`                        | The E2E database defaults to `${TEST_DB_NAME}_e2e`, or `erp_coaching_test_e2e` without it                     |
| `E2E_DB_NAME`                                  | see above                             | Explicit E2E database name (must contain `e2e`)                                                               |
| `E2E_API_PORT` / `E2E_WEB_PORT`                | `4105` / `5205`                       | Ports for the API and the web app                                                                             |
| `E2E_API_LOG_LEVEL`                            | `warn`                                | API log level, printed with an `[api]` prefix. At `info` the log also shows every message sent (OTPs, alerts) |
| `CI`                                           | unset                                 | CI mode (see above)                                                                                           |

No `backend/.env` is needed: on CI the DB variables above are enough.

## CI

The `e2e` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs every spec on each
pull request and push to `main`. It uses a `mysql:8.4` service on 127.0.0.1:3306 (root/root,
`TEST_DB_NAME=erp_coaching_test`), Node 22 and Chromium with its OS dependencies (cached by the
lockfile hash), and sets `CI=true`. On failure it uploads the HTML report, `test-results/` (traces
and screenshots) and the dev outbox as the `e2e-results` artifact. A run takes about 2 minutes on an
idle machine: about 20 s of database reset and server start, then 10–45 s per spec.

## Adding a workflow spec

1. **One file per workflow:** `tests/<workflow>.spec.ts`. Start it with a doc comment naming the
   spec §7 workflow and saying what is set up through the API and what is done in the browser.
2. **Import `test` and `expect` from `../support/fixtures`**, not from `@playwright/test`. The
   fixtures are:
   - `http`: an `APIRequestContext`.
   - `superAdmin`: the seeded platform admin, signed in through the API.
   - `openAs(session, path)`: a new browser context signed in as an API session (on that session's
     device, so it doesn't count as another one), or anonymous with `null`. Contexts are closed
     after the test.
3. **Set up through the API** with the builders in `support/data.ts`:
   - `createInstitute(http, superAdmin, label)`: a new institute and its admin session,
     `institute.admin`;
   - `addStaff`, `addStudent`, `addGuardian`, `createBatch`;
   - `uniqueId()` for names, slugs and codes;
   - `uniqueMobile()` for mobiles in the reserved `9459…` range;
   - `isoDate(offsetDays)` for the institute's date (Asia/Kolkata).

   For your module's own setup, call its endpoints with `session.api.get/post/put/patch/delete`.
   Failures throw `ApiError`, which carries the backend's `{ error: { code, message } }`. Move a
   builder into `data.ts` once a second spec needs it.

4. **Signing in:** for most users, `loginWithPassword(http, person, newDevice('label'))` and then
   `openAs(session, '/path')`. Drive the login UI only when signing in is part of the workflow:
   `signInWithOtp(page, mobile)` reads the OTP from the outbox.
5. **Locators.** Prefer roles, labels and text over CSS, and don't add `data-testid`s without the
   owning team. Use the helpers in `support/ui.ts`:
   - `activePage(page)` scopes to the visible Ionic page; Ionic keeps earlier pages in the DOM.
   - `modal`, `alertDialog` and `actionSheet` locate overlays.
   - `confirmAlert`, `expectToast`, `selectSegment` and `chooseOption` (ion-select) act on them.

   Two Ionic gotchas:
   - `ion-button` and `ion-item` with a `router-link` have the role `link`.
   - Text in Ionic `<p>`s starts with whitespace, so don't anchor text regexes with `^`.

6. **Messages:** take `const since = outboxMark()` before the action, then
   `waitForMessage(predicate, { since })`. To assert that nothing was sent, use
   `outboxMessages(since)`.
7. **Waiting for background effects.** Don't poll by reloading the page.
   - After every `goto` or `reload`, wait for content of the target page before navigating again.
     The app signs the user out if a navigation aborts its start-up `/auth/me` request (see
     below).
   - Wait for a server-side signal instead (an outbox message, or the API), then open or reload
     the page once.
   - In-app notifications are stored in the same `notify()` call that queues the SMS, WhatsApp,
     email and push messages. Once a parent's SMS is in the outbox, their in-app notification
     exists.
8. **Conventions:**
   - Specs are independent and order-insensitive: create your own institute and users with unique
     names, and never rely on the demo seed or another spec.
   - Use one `test.step` per user-facing step.
   - Use web-first assertions; no `waitForTimeout`.
   - Aim for under 60 s per spec.
9. **Before pushing**, run:
   - `npx playwright test tests/<file> --repeat-each=2` (it must pass without retries);
   - `npm run typecheck -w @erp/e2e`;
   - `npx prettier --check e2e`;
   - `npm run lint`.

## Known issues

- **Navigating while the app starts signs the user out.** `init()` in `app/src/stores/auth.ts`
  clears the stored session on any error from `/auth/me`, including a request aborted by a
  navigation or a network error. Specs therefore never navigate while a page is still starting.
- **tsx comes from the backend workspace.** It is not a dependency of this package; npm hoists it
  to the root.
