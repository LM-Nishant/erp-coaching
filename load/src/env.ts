/**
 * Load-test settings, all from environment variables (see docs/load-testing.md). The spec sets no
 * performance targets yet, so durations, concurrency and thresholds are all configurable.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOAD_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(LOAD_DIR, '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
/** Scratch space of `serve:api` (outbox file, uploaded media); gitignored. */
export const TMP_DIR = path.join(LOAD_DIR, '.tmp');
export const RESULTS_DIR = path.join(LOAD_DIR, 'results');

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return value;
}

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number ≥ 0 (got "${raw}")`);
  return value;
}

export const API_URL = (process.env.LOAD_API_URL?.trim() || 'http://localhost:4105').replace(/\/+$/, '');

export const settings = {
  /** Seconds each duration-based scenario runs. */
  durationSeconds: positiveInt('LOAD_DURATION', 15),
  /** Concurrent HTTP connections (virtual users) per scenario. */
  connections: positiveInt('LOAD_CONNECTIONS', 10),
  /** Students (each with a parent) created for the run; also the size of the exam-submit burst. */
  students: positiveInt('LOAD_STUDENTS', 20),
  /** Per-request timeout in seconds; a timed-out request counts as an error. */
  timeoutSeconds: positiveInt('LOAD_TIMEOUT', 10),
  /** Comma-separated scenario names (default: all). Positional CLI arguments override it. */
  scenarios: (process.env.LOAD_SCENARIOS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  thresholdsFile: process.env.LOAD_THRESHOLDS?.trim()
    ? path.resolve(process.env.LOAD_THRESHOLDS.trim())
    : path.join(LOAD_DIR, 'thresholds.json'),
  superAdmin: {
    mobile: process.env.LOAD_SUPERADMIN_MOBILE?.trim() || '9000000000',
    password: process.env.LOAD_SUPERADMIN_PASSWORD?.trim() || 'Admin@12345',
  },
  /** An existing super-admin access token; skips the super-admin login. */
  superAdminToken: process.env.LOAD_SUPERADMIN_TOKEN?.trim() || undefined,
  /** Where the API writes OTPs (DEV_OUTBOX_FILE); used when a login needs a new-device OTP. */
  outboxFile: process.env.LOAD_OUTBOX_FILE?.trim()
    ? path.resolve(process.env.LOAD_OUTBOX_FILE.trim())
    : path.join(TMP_DIR, 'outbox.jsonl'),
};

/** Global threshold overrides; they win over thresholds.json for every scenario. */
export const thresholdOverrides = {
  maxP50Ms: optionalNumber('LOAD_MAX_P50_MS'),
  maxP95Ms: optionalNumber('LOAD_MAX_P95_MS'),
  maxP99Ms: optionalNumber('LOAD_MAX_P99_MS'),
  maxErrorRate: optionalNumber('LOAD_MAX_ERROR_RATE'),
  minRps: optionalNumber('LOAD_MIN_RPS'),
};

/** Minimal reader for backend/.env (only used to derive the load database name). */
export function readBackendDotenv(): Record<string, string> {
  const file = path.join(BACKEND_DIR, '.env');
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const quoted = /^(['"])(.*)\1$/.exec(match[2]);
    values[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '');
  }
  return values;
}
