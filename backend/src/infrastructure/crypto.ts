import crypto from 'node:crypto';
import { config } from './config';

export interface EncryptionKey {
  /** Short id derived from the key (an HMAC fingerprint), stored with every ciphertext. */
  id: string;
  key: Buffer;
  /** The key as configured (base64). */
  encoded: string;
}

interface KeyRing {
  current: EncryptionKey;
  previous: EncryptionKey[];
  byId: Map<string, EncryptionKey>;
  source: string;
}

function parseKey(encoded: string, setting: string): EncryptionKey {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error(`${setting} must be 32 bytes, base64 encoded`);
  const id = crypto.createHmac('sha256', key).update('erp-coaching encryption key id').digest('base64url');
  return { id: id.slice(0, 8), key, encoded };
}

let ring: KeyRing | null = null;

/**
 * The key ring: `ENCRYPTION_KEY` encrypts; it and `ENCRYPTION_PREVIOUS_KEYS` decrypt. Rebuilt when the config
 * changes (tests rotate keys in-process).
 */
export function encryptionKeys(): KeyRing {
  const source = `${config.ENCRYPTION_KEY}|${config.ENCRYPTION_PREVIOUS_KEYS}`;
  if (ring?.source === source) return ring;
  const current = parseKey(config.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
  const byId = new Map([[current.id, current]]);
  for (const encoded of config.ENCRYPTION_PREVIOUS_KEYS.split(',')) {
    if (!encoded.trim()) continue;
    const k = parseKey(encoded.trim(), 'Each ENCRYPTION_PREVIOUS_KEYS entry');
    const same = byId.get(k.id);
    if (same && !same.key.equals(k.key))
      throw new Error('Two encryption keys share an id: generate a new key');
    if (!same) byId.set(k.id, k);
  }
  ring = { current, previous: [...byId.values()].slice(1), byId, source };
  return ring;
}
encryptionKeys();

/** AES-256-GCM with the current key. Output: v2:<key id>:<iv>:<tag>:<ciphertext> (base64). */
export function encryptSecret(plain: string): string {
  const { current } = encryptionKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v2',
    current.id,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

function open(key: Buffer, iv: string, tag: string, data: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const MISSING_KEY = 'add the key it was encrypted with to ENCRYPTION_PREVIOUS_KEYS';

/** Decrypts with the key the value names. v1 values (written before key ids) try each configured key. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  const keys = encryptionKeys();
  if (parts[0] === 'v2' && parts.length === 5) {
    const key = keys.byId.get(parts[1]);
    if (!key) throw new Error(`Secret encrypted with unknown key ${parts[1]}: ${MISSING_KEY}`);
    return open(key.key, parts[2], parts[3], parts[4]);
  }
  const [version, iv, tag, data] = parts;
  if (version !== 'v1' || parts.length !== 4 || !iv || !tag || !data)
    throw new Error('Unsupported secret format');
  for (const key of keys.byId.values()) {
    try {
      return open(key.key, iv, tag, data);
    } catch {
      // GCM authentication fails with any other key: try the next one.
    }
  }
  throw new Error(`Secret encrypted with an unknown key: ${MISSING_KEY}`);
}

/** Id of the key a stored value was encrypted with; null for a v1 value, which names none. */
export function secretKeyId(payload: string): string | null {
  const parts = payload.split(':');
  return parts[0] === 'v2' && parts.length === 5 ? parts[1] : null;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmac(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

/** `AQ….Sf9Q` style hint for secrets that must never be returned. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 2)}….${secret.slice(-4)}`;
}
