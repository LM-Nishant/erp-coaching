import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../infrastructure/config';
import { logger } from '../../infrastructure/logger';
import { verifyPassword } from '../../infrastructure/password';
import { getRedis, type RedisClient } from '../../infrastructure/redis';
import { audit } from '../../shared/audit/audit.service';
import { AppError } from '../../shared/errors';

/**
 * Per-account sign-in lockout for failed password, OTP and device-unlock attempts.
 *
 * Failures count per account and *scope*. Each device the user is signed in on is its own scope, and every
 * other device shares scope 0. Someone guessing from elsewhere can only lock scope 0, so the user keeps
 * signing in on the devices they already use. After LOGIN_LOCKOUT_THRESHOLD failures the scope locks for
 * LOGIN_LOCKOUT_BASE_SECONDS, doubling with each further failure up to LOGIN_LOCKOUT_MAX_SECONDS. Attempts
 * during a lock are refused without checking the credential and don't extend it, so every lock ends by itself.
 * A successful sign-in clears its scope; an administrator clears them all.
 *
 * Identifiers without an account get the same treatment under a keyed hash of the identifier, so the
 * responses don't reveal whether an account exists. Attempts for one account and scope run one at a time
 * (others wait up to a few seconds), so parallel requests can't slip extra guesses in before the lock.
 *
 * State is kept in Redis when REDIS_URL is set (in this process otherwise, or while Redis is unreachable)
 * and is forgotten a day after the last failure.
 */

export type SignInMethod = 'password' | 'otp' | 'biometric';

export interface SignInSubject {
  /** `u<userId>` for accounts, `x<tag>` for identifiers without one. */
  account: string;
  /** The user's signed-in device the attempt comes from, else 0. */
  scope: number;
  userId: number | null;
}

export interface SignInAttempt {
  /** Records a failure; throws ACCOUNT_LOCKED when it locks the scope. */
  failed(method: SignInMethod): Promise<void>;
  succeeded(): Promise<void>;
}

interface ScopeState {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

const FAILURE_MEMORY_MS = 24 * 3600_000;
const GATE_MS = 10_000;
const GATE_WAIT_MS = 3_000;
const MAX_MEMORY_ACCOUNTS = 100_000;

export const userSubject = (userId: number, scope = 0): SignInSubject => ({
  account: `u${userId}`,
  scope,
  userId,
});

/**
 * Keyed tag of a mobile number or email (16 hex characters). OTP challenge ids start with the tag of their
 * number, so failures on challenges of numbers without an account are counted like real ones.
 */
export function identifierTag(identifier: string): string {
  const mac = crypto
    .createHmac('sha256', config.OTP_HASH_SECRET)
    .update(`account:${identifier.trim().toLowerCase()}`)
    .digest()
    .subarray(0, 8);
  mac[6] = (mac[6] & 0x0f) | 0x40; // the UUID version nibble, see challengeIdFor
  return mac.toString('hex');
}

export const tagSubject = (tag: string): SignInSubject => ({ account: `x${tag}`, scope: 0, userId: null });

/** A version-4-shaped UUID: the 8-byte identifier tag, then 8 random bytes. */
export function challengeIdFor(tag: string): string {
  const b = Buffer.concat([Buffer.from(tag, 'hex'), crypto.randomBytes(8)]);
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const challengeTag = (challengeId: string) => challengeId.replace(/-/g, '').slice(0, 16).toLowerCase();

function lockedError(ms: number) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.ceil(seconds / 60);
  const e = new AppError(
    429,
    'ACCOUNT_LOCKED',
    `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfterSeconds: seconds },
  );
  e.retryAfterSeconds = seconds;
  return e;
}

function busyError() {
  const e = new AppError(
    429,
    'SIGN_IN_BUSY',
    'Another sign-in for this account is in progress. Try again in a moment.',
  );
  e.retryAfterSeconds = 1;
  return e;
}

// ------------------------------------------------------------------ storage

interface Backend {
  read(account: string): Promise<Map<string, ScopeState>>;
  write(account: string, scope: string, state: ScopeState): Promise<void>;
  clear(account: string, scope?: string): Promise<void>;
  acquire(gate: string): Promise<boolean>;
  release(gate: string): Promise<void>;
}

const encode = (s: ScopeState) => `${s.failures}:${s.lockedUntil}:${s.lastFailureAt}`;
function decode(raw: string): ScopeState | null {
  const [failures, lockedUntil, lastFailureAt] = raw.split(':').map(Number);
  return [failures, lockedUntil, lastFailureAt].every(Number.isFinite)
    ? { failures, lockedUntil, lastFailureAt }
    : null;
}

class MemoryBackend implements Backend {
  private accounts = new Map<string, { expires: number; scopes: Map<string, ScopeState> }>();
  private gates = new Map<string, number>();

  async read(account: string) {
    const a = this.accounts.get(account);
    if (a && a.expires > Date.now()) return new Map(a.scopes);
    this.accounts.delete(account);
    return new Map<string, ScopeState>();
  }

  async write(account: string, scope: string, state: ScopeState) {
    const now = Date.now();
    const current = this.accounts.get(account);
    const a = current && current.expires > now ? current : { expires: 0, scopes: new Map() };
    a.scopes.set(scope, state);
    a.expires = Math.max(now + FAILURE_MEMORY_MS, state.lockedUntil);
    // Re-inserted so the oldest accounts come first when the map is full.
    this.accounts.delete(account);
    this.accounts.set(account, a);
    if (this.accounts.size > MAX_MEMORY_ACCOUNTS) this.accounts.delete(this.accounts.keys().next().value!);
  }

  async clear(account: string, scope?: string) {
    if (scope === undefined) this.accounts.delete(account);
    else this.accounts.get(account)?.scopes.delete(scope);
  }

  async acquire(gate: string) {
    const now = Date.now();
    if ((this.gates.get(gate) ?? 0) > now) return false;
    this.gates.set(gate, now + GATE_MS);
    return true;
  }

  async release(gate: string) {
    this.gates.delete(gate);
  }
}

class RedisBackend implements Backend {
  constructor(private readonly client: RedisClient) {}

  private key = (account: string) => `signin:${account}`;

  async read(account: string) {
    const raw = await this.client.hGetAll(this.key(account));
    const scopes = new Map<string, ScopeState>();
    for (const [scope, value] of Object.entries(raw)) {
      const state = decode(value);
      if (state) scopes.set(scope, state);
    }
    return scopes;
  }

  async write(account: string, scope: string, state: ScopeState) {
    const ttl = Math.max(FAILURE_MEMORY_MS, state.lockedUntil - Date.now());
    await this.client
      .multi()
      .hSet(this.key(account), scope, encode(state))
      .pExpire(this.key(account), ttl)
      .exec();
  }

  async clear(account: string, scope?: string) {
    if (scope === undefined) await this.client.del(this.key(account));
    else await this.client.hDel(this.key(account), scope);
  }

  async acquire(gate: string) {
    const ok = await this.client.set(`signin-gate:${gate}`, '1', {
      condition: 'NX',
      expiration: { type: 'PX', value: GATE_MS },
    });
    return ok === 'OK';
  }

  async release(gate: string) {
    await this.client.del(`signin-gate:${gate}`);
  }
}

const memory = new MemoryBackend();
let warnedAt = 0;

async function store<T>(op: (b: Backend) => Promise<T>): Promise<T> {
  const client = getRedis();
  if (client?.isReady) {
    try {
      return await op(new RedisBackend(client));
    } catch (err) {
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        logger.warn({ err }, 'Redis sign-in lock store failed; using memory');
      }
    }
  }
  return op(memory);
}

// ------------------------------------------------------------------ attempts

async function acquireGate(gate: string): Promise<boolean> {
  const deadline = Date.now() + GATE_WAIT_MS;
  for (let delay = 20; ; delay = Math.min(delay * 2, 250)) {
    if (await store((b) => b.acquire(gate))) return true;
    if (Date.now() + delay > deadline) return false;
    await sleep(delay * (0.5 + Math.random()));
  }
}

const NO_LOCK: SignInAttempt = { failed: async () => undefined, succeeded: async () => undefined };

/**
 * Runs one sign-in attempt for `subject`: refuses it while the scope is locked or another attempt for it is
 * running, and lets `run` report the outcome.
 */
export async function guardSignIn<T>(
  subject: SignInSubject,
  run: (attempt: SignInAttempt) => Promise<T>,
): Promise<T> {
  const threshold = config.LOGIN_LOCKOUT_THRESHOLD;
  if (!threshold) return run(NO_LOCK);
  const scope = String(subject.scope);
  const gate = `${subject.account}:${scope}`;
  if (!(await acquireGate(gate))) throw busyError();
  try {
    const state = (await store((b) => b.read(subject.account))).get(scope);
    if (state && state.lockedUntil > Date.now()) throw lockedError(state.lockedUntil - Date.now());
    return await run({
      failed: async (method) => {
        const now = Date.now();
        const before = state && now - state.lastFailureAt < FAILURE_MEMORY_MS ? state.failures : 0;
        const failures = before + 1;
        const over = failures - threshold;
        const lockMs =
          over >= 0
            ? Math.min(
                config.LOGIN_LOCKOUT_MAX_SECONDS,
                config.LOGIN_LOCKOUT_BASE_SECONDS * 2 ** Math.min(over, 20),
              ) * 1000
            : 0;
        const lockedUntil = lockMs ? now + lockMs : 0;
        await store((b) => b.write(subject.account, scope, { failures, lockedUntil, lastFailureAt: now }));
        if (!lockMs) return;
        if (subject.userId)
          await audit({
            action: 'auth.sign_in_locked',
            entityType: 'user',
            entityId: subject.userId,
            instituteId: null,
            metadata: {
              method,
              deviceId: subject.scope || null,
              failures,
              lockedUntil: new Date(lockedUntil).toISOString(),
            },
          });
        throw lockedError(lockMs);
      },
      succeeded: async () => {
        if (state) await store((b) => b.clear(subject.account, scope));
      },
    });
  } finally {
    await store((b) => b.release(gate)).catch(() => undefined);
  }
}

/**
 * Checks the password of an existing account outside sign-in (e.g. to attach the account to a
 * self-registration). Failures count towards the account's lock like failed sign-ins from a new device.
 */
export async function confirmAccountPassword(
  user: { id: number; passwordHash: string | null },
  password: string,
): Promise<boolean> {
  return guardSignIn(userSubject(user.id), async (attempt) => {
    if (!(await verifyPassword(password, user.passwordHash)).ok) {
      await attempt.failed('password');
      return false;
    }
    await attempt.succeeded();
    return true;
  });
}

// ------------------------------------------------------------------ administration

/** Users whose sign-in is locked on some device or for new devices, with the latest end of their locks. */
export async function signInLocks(userIds: number[]): Promise<Map<number, Date>> {
  const now = Date.now();
  const locks = new Map<number, Date>();
  await Promise.all(
    userIds.map(async (id) => {
      const scopes = await store((b) => b.read(`u${id}`));
      const until = Math.max(0, ...[...scopes.values()].map((s) => s.lockedUntil));
      if (until > now) locks.set(id, new Date(until));
    }),
  );
  return locks;
}

/** Clears a user's failed attempts and locks on every device. Callers check that the requester may. */
export async function clearSignInLock(userId: number): Promise<void> {
  const scopes = await store((b) => b.read(`u${userId}`));
  await store((b) => b.clear(`u${userId}`));
  if (!scopes.size) return;
  const until = Math.max(0, ...[...scopes.values()].map((s) => s.lockedUntil));
  await audit({
    action: 'auth.sign_in_unlocked',
    entityType: 'user',
    entityId: userId,
    metadata: { wasLocked: until > Date.now() },
  });
}
