import crypto from 'node:crypto';

/**
 * Paytm checksum ("signature"), as in Paytm's official checksum libraries (PaytmChecksum for
 * Node, PHP, Python, Java): `base64(AES-128-CBC(sha256hex(params + "|" + salt) + salt))` with the
 * 16-character merchant key and a fixed IV. JSON APIs sign the exact JSON string of `body`; form
 * posts (callbacks, webhooks) sign the values sorted by key and joined with "|".
 */
const IV = Buffer.from('@@@@&&&&####$$$$', 'latin1');
const SALT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export class PaytmChecksumError extends Error {}

function cipherKey(merchantKey: string): Buffer {
  const key = Buffer.from(merchantKey, 'utf8');
  if (key.length !== 16) throw new PaytmChecksumError('The Paytm merchant key must be 16 characters');
  return key;
}

function encrypt(input: string, merchantKey: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', cipherKey(merchantKey), IV);
  return Buffer.concat([cipher.update(input, 'latin1'), cipher.final()]).toString('base64');
}

function decrypt(encrypted: string, merchantKey: string): string | null {
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', cipherKey(merchantKey), IV);
    return Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]).toString('latin1');
  } catch (err) {
    if (err instanceof PaytmChecksumError) throw err;
    return null;
  }
}

function hashWithSalt(params: string, salt: string): string {
  return crypto.createHash('sha256').update(`${params}|${salt}`, 'utf8').digest('hex') + salt;
}

function randomSalt(): string {
  const bytes = crypto.randomBytes(4);
  return Array.from(bytes, (b) => SALT_CHARS[b % SALT_CHARS.length]).join('');
}

type FormParams = Record<string, string | null | undefined>;

/**
 * Values sorted by key and joined with "|". `blankNullStrings` follows Paytm's PHP/Python/Java
 * libraries (the string "null" signs as empty); the Node library signs it verbatim.
 */
export function paytmParamsString(params: FormParams, blankNullStrings = true): string {
  return Object.keys(params)
    .filter((k) => k !== 'CHECKSUMHASH')
    .sort()
    .map((k) => {
      const v = params[k];
      if (v == null) return '';
      return blankNullStrings && v.toLowerCase() === 'null' ? '' : v;
    })
    .join('|');
}

/** Checksum of a JSON body string or of form params; `salt` (4 characters) is random unless given. */
export function generatePaytmChecksum(
  params: string | FormParams,
  merchantKey: string,
  salt?: string,
): string {
  const s = salt ?? randomSalt();
  if (s.length !== 4) throw new PaytmChecksumError('The checksum salt must be 4 characters');
  const str = typeof params === 'string' ? params : paytmParamsString(params);
  return encrypt(hashWithSalt(str, s), merchantKey);
}

function sameText(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'latin1');
  const bb = Buffer.from(b, 'latin1');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Verifies a checksum made by Paytm (or any official library) over a JSON body string or form params. */
export function verifyPaytmChecksum(
  params: string | FormParams,
  merchantKey: string,
  checksum: string | undefined | null,
): boolean {
  if (!checksum) return false;
  const hash = decrypt(checksum, merchantKey);
  if (!hash || hash.length !== 68) return false;
  const salt = hash.slice(-4);
  const candidates =
    typeof params === 'string'
      ? [params]
      : [paytmParamsString(params, true), paytmParamsString(params, false)];
  return candidates.some((c) => sameText(hashWithSalt(c, salt), hash));
}
