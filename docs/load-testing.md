# Load testing

`load/` holds [autocannon](https://github.com/mcollina/autocannon) scenarios for the endpoints that
take the most traffic (spec §10, §11.1). A run creates a fresh institute through the API, drives each
scenario in turn, prints a summary table, writes a JSON report to `load/results/` (gitignored) and
exits non-zero when a scenario breaches its thresholds.

## Running it locally

```bash
npm run load:serve          # terminal 1: API on :4105 with its own database, rate limits off
npm run load                # terminal 2: every scenario
npm run load -- dashboards lists     # a subset
npm run load -- --list               # scenario names and what they hit
```

`load:serve` resets the database `LOAD_DB_NAME` (default `${TEST_DB_NAME}_load`; the name must
contain `load`), seeds it, and starts the API without watch mode at `LOG_LEVEL=warn`, with the
console messaging providers and local-disk storage under `load/.tmp/`. Set `LOAD_KEEP_DB=true` to
keep the data between restarts. The runner signs in the seeded super admin with a fixed device id;
if that login needs a new-device OTP it reads it from `load/.tmp/outbox.jsonl`, or prompts for it.

To test another API (a staging stack, the Docker Compose stack), point `LOAD_API_URL` at it and
either pass a super-admin access token in `LOAD_SUPERADMIN_TOKEN` or the super admin's credentials
in `LOAD_SUPERADMIN_MOBILE`/`LOAD_SUPERADMIN_PASSWORD`. Switch its rate limits off
(`RATE_LIMIT_ENABLED=false`) first, or the run measures 429s. Never point it at production: every
run creates an institute with a teacher, students and parents (`Load <id>`, mobiles `9458……`).

## Scenarios

| Scenario      | Requests                                                                                                                           | As                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `login`       | `POST /auth/login` with a password on a known device                                                                               | students                                                            |
| `dashboards`  | parent: `/parent-portal/children`, `/parent-portal/children/:id/summary`                                                           | parents, students, the institute admin and the super admin, by turn |
|               | student: `/attendance/me/summary`, `/notifications/inbox`, `/exams/my`                                                             |                                                                     |
|               | admin: `/subscription`, `/notifications/inbox`; super admin: `/admin/dashboard`                                                    |                                                                     |
| `lists`       | `/students?pageSize=25`, `/academics/batches`, `/academics/courses`, `/exams`, `/lms/resources`, `/live-classes`, `/fees/accounts` | institute admin                                                     |
| `lms-play`    | `POST /lms/resources/:id/play` (access check, signed URL issue)                                                                    | students                                                            |
| `lms-media`   | `GET /api/files/signed/:token` with 256 KiB `Range` requests across a 1 MiB file on local disk                                     | students' signed URLs                                               |
| `live-join`   | `POST /live-classes/:id/join` for a class in progress (membership check, room token)                                               | students                                                            |
| `exam-save`   | `PUT /exams/my/attempts/:id/answers/:eqId` (answer autosave), one attempt per connection                                           | students                                                            |
| `exam-submit` | `POST /exams/my/attempts/:id/submit`: every student submits a fresh exam at once (`LOAD_STUDENTS` requests in total)               | students                                                            |

Each connection has its own request list and cycles through it, so one connection plays the parent
of student 1 while the next is student 2, and so on. Signed media URLs are issued just before
`lms-media` runs; keep `LOAD_DURATION` below the API's `SIGNED_URL_TTL_SECONDS` (300 s by default).
`live-join` covers the HTTP join only: the Socket.IO session that follows is not load-tested (see
"Live classes" in [deployment.md](deployment.md) for why one API node holds all room state).

To add a scenario, append it to `load/src/scenarios.ts` (a name, a summary and a `plan()` that
returns the request list per connection); fixtures it needs belong in `load/src/fixtures.ts`.

## Settings

| Variable                                                | Default                                 | Meaning                                                                  |
| ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `LOAD_API_URL`                                          | `http://localhost:4105`                 | API origin (without `/api`)                                              |
| `LOAD_DURATION`                                         | `15`                                    | seconds per duration-based scenario                                      |
| `LOAD_CONNECTIONS`                                      | `10`                                    | concurrent connections (virtual users)                                   |
| `LOAD_STUDENTS`                                         | `20`                                    | students (each with a parent) per run; also the `exam-submit` burst size |
| `LOAD_TIMEOUT`                                          | `10`                                    | seconds before a request counts as timed out                             |
| `LOAD_SCENARIOS`                                        | all                                     | comma-separated scenario names (positional arguments win)                |
| `LOAD_THRESHOLDS`                                       | `load/thresholds.json`                  | thresholds file                                                          |
| `LOAD_MAX_P50_MS`, `LOAD_MAX_P95_MS`, `LOAD_MAX_P99_MS` | —                                       | latency limits for every scenario (override the file)                    |
| `LOAD_MAX_ERROR_RATE`                                   | —                                       | maximum failed fraction, 0–1 (non-2xx, connection errors and timeouts)   |
| `LOAD_MIN_RPS`                                          | —                                       | minimum requests per second                                              |
| `LOAD_SUPERADMIN_MOBILE`, `LOAD_SUPERADMIN_PASSWORD`    | the seeded `9000000000` / `Admin@12345` | super admin that creates the load institute                              |
| `LOAD_SUPERADMIN_TOKEN`                                 | —                                       | use this access token instead of signing in                              |
| `LOAD_OUTBOX_FILE`                                      | `load/.tmp/outbox.jsonl`                | the API's `DEV_OUTBOX_FILE`, read for new-device OTPs                    |
| `LOAD_DB_NAME`, `LOAD_KEEP_DB`, `LOAD_API_LOG_LEVEL`    | `${TEST_DB_NAME}_load`, `false`, `warn` | `load:serve` only                                                        |

## Thresholds

The spec sets no performance targets yet, so every limit is configurable. `load/thresholds.json`
holds `defaults` plus per-scenario blocks (`maxP50Ms`, `maxP95Ms`, `maxP99Ms`, `maxErrorRate`,
`minRps`); the `LOAD_MAX_*` and `LOAD_MIN_RPS` variables override both. Precedence: file defaults <
file scenario block < environment.

The committed values are guard rails, roughly 4–5× the better of the baseline runs below, sized for
the default 10 connections. They catch order-of-magnitude regressions (an N+1 query, a missing
index, a blocking call on the event loop) without flaking on a busy laptop; they are not SLOs. When
the product sets targets, put them in the file (or in a separate file passed as `LOAD_THRESHOLDS`)
and measure on hardware that resembles production. Latency grows with `LOAD_CONNECTIONS` once the
API is saturated, so raise the latency limits with it, or gate on `minRps` instead.

Percentiles are nearest-rank over every response; the error rate counts non-2xx responses,
connection errors and timeouts. The run exits 0 when all thresholds hold, 1 on a breach and 2 when
setup fails.

## Local baseline

Two consecutive runs with the defaults (`npm run load`: 10 connections, 15 s per scenario, 20
students) against `npm run load:serve` on 2026-11-18. Machine: Intel Core i5-1038NG7 (4 cores, 8
threads, 2.0 GHz), 16 GB, macOS 26, Node 22.19, MySQL 8.4.7 on the same machine, one API process.
The laptop was shared with other busy workloads (load average 24 and 88 during the two runs), so
treat these as an upper bound and re-baseline on a quiet or dedicated machine. Each cell shows
run 1 / run 2.

| Scenario      | req/s       | p50 ms      | p95 ms      | p99 ms      | errors |
| ------------- | ----------- | ----------- | ----------- | ----------- | ------ |
| `login`       | 4.2 / 1.9   | 2317 / 4024 | 3041 / 6363 | 3083 / 6373 | 0%     |
| `dashboards`  | 47.2 / 20.5 | 163 / 319   | 502 / 1158  | 1151 / 3740 | 0%     |
| `lists`       | 37.8 / 12.4 | 229 / 722   | 489 / 1402  | 682 / 1688  | 0%     |
| `lms-play`    | 33.7 / 23.8 | 280 / 355   | 455 / 892   | 582 / 1337  | 0%     |
| `lms-media`   | 335 / 335   | 28 / 28     | 44 / 45     | 57 / 61     | 0%     |
| `live-join`   | 56.1 / 28.0 | 170 / 316   | 231 / 642   | 312 / 725   | 0%     |
| `exam-save`   | 50.6 / 58.5 | 174 / 166   | 285 / 225   | 752 / 272   | 0%     |
| `exam-submit` | 20 requests | 261 / 211   | 307 / 256   | 312 / 268   | 0%     |

What the numbers say:

- **Login was CPU-bound on the event loop.** This baseline hashed passwords with `bcryptjs` (pure
  JavaScript, cost 10, about 120 ms per comparison on this machine) on the API's single JavaScript
  thread, so one API process managed only a handful of logins per second, and a login burst
  (everyone signing in before an exam) delayed every other request on that process. Passwords are
  now hashed with scrypt on libuv's thread pool (`backend/src/infrastructure/password.ts`; older
  bcrypt hashes are checked on a worker thread and replaced at the next sign-in), so a burst no
  longer holds up other requests. Sign-ins per process are still bounded by `UV_THREADPOOL_SIZE`
  and the CPU cores ([scaling](deployment.md#scaling)); run `login` again for a new baseline. Keep
  `LOAD_STUDENTS` at or above `LOAD_CONNECTIONS` for it: attempts for the same account take turns.
  With `REDIS_URL` set, several API processes share rate limits, sign-in locks and live classes.
- **Reads are dominated by MySQL round trips**: dashboards and lists sit at 150–300 ms p50 at 10
  connections on a loaded laptop; nothing failed or timed out.
- **Media is cheap**: signed, ranged local-disk reads stay under 50 ms p95.

## In CI

`.github/workflows/load.yml` runs a short smoke on demand (`workflow_dispatch`, with duration and
connection inputs) against a MySQL service container and uploads `load/results/`. It is manual on
purpose: shared CI runners are too noisy for latency gates on every pull request.
