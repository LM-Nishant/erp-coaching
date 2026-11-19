import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { config } from './config';

/**
 * Password hashing that never runs on the event loop.
 * - New hashes use scrypt, which runs on the libuv threadpool: `scrypt$N$r$p$salt$key` (base64).
 * - Legacy bcrypt hashes (`$2a$`, `$2b$`, `$2y$`) are verified in a worker thread. `needsRehash` is then
 *   true, so sign-in replaces them; it is also true for scrypt hashes made with older parameters.
 */
export interface PasswordCheck {
  ok: boolean;
  needsRehash: boolean;
}

// OWASP's scrypt profile (N=2^15, r=8, p=3: 32 MiB per hash); PASSWORD_HASH_COST sets N.
const CURRENT = { N: 2 ** config.PASSWORD_HASH_COST, r: 8, p: 3 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

type Params = typeof CURRENT;

function derive(password: string, salt: Buffer, { N, r, p }: Params, keyBytes = KEY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keyBytes, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, CURRENT);
  const { N, r, p } = CURRENT;
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

let dummy: Promise<string> | null = null;

/**
 * Checks a password against a stored hash. Without a hash (unknown user, OTP-only account) it still
 * derives a key, so the response time doesn't reveal whether the account exists.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<PasswordCheck> {
  const no = { ok: false, needsRehash: false };
  if (!stored) {
    await verifyPassword(password, await (dummy ??= hashPassword(crypto.randomUUID())));
    return no;
  }
  if (BCRYPT.test(stored)) {
    const ok = await bcryptCompare(password, stored);
    return { ok, needsRehash: ok };
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return no;
  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  const valid =
    Number.isInteger(Math.log2(params.N)) &&
    params.N >= 2 ** 10 &&
    params.N <= 2 ** 20 &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= 32 &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= 16;
  const expected = Buffer.from(parts[5], 'base64');
  if (!valid || expected.length < 16) return no;
  const actual = await derive(password, Buffer.from(parts[4], 'base64'), params, expected.length);
  const ok = crypto.timingSafeEqual(expected, actual);
  const current = params.N === CURRENT.N && params.r === CURRENT.r && params.p === CURRENT.p;
  return { ok, needsRehash: ok && (!current || expected.length !== KEY_BYTES) };
}

// ------------------------------------------------------------------ legacy bcrypt, in a worker

type Pending = { resolve: (ok: boolean) => void; reject: (err: Error) => void };
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function bcryptWorker(): Worker {
  if (worker) return worker;
  const source = `
    const { parentPort } = require('node:worker_threads');
    const bcrypt = require(${JSON.stringify(require.resolve('bcryptjs'))});
    parentPort.on('message', ({ id, password, hash }) => {
      let ok = false;
      try { ok = bcrypt.compareSync(password, hash); } catch {}
      parentPort.postMessage({ id, ok });
    });`;
  const w = new Worker(source, { eval: true });
  const failAll = (err: Error) => {
    if (worker === w) worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  w.on('message', ({ id, ok }: { id: number; ok: boolean }) => {
    pending.get(id)?.resolve(ok);
    pending.delete(id);
    if (!pending.size) w.unref();
  });
  w.on('error', failAll);
  w.on('exit', () => failAll(new Error('Password worker stopped')));
  worker = w;
  return w;
}

function bcryptCompare(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    const w = bcryptWorker();
    // Keep the process alive only while a check is running.
    w.ref();
    w.postMessage({ id, password, hash });
  });
}
