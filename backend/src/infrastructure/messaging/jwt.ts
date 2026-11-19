import crypto from 'node:crypto';
import { MessagingError } from './errors';

/** Private keys pasted into settings: PEM (with literal `\n` from JSON files) or bare base64 PKCS#8. */
export function parsePrivateKey(
  vendor: string,
  raw: string,
  label: string,
  type: 'rsa' | 'ec',
): crypto.KeyObject {
  const text = raw.replace(/\\n/g, '\n').trim();
  let key: crypto.KeyObject;
  try {
    key = text.includes('-----BEGIN')
      ? crypto.createPrivateKey(text)
      : crypto.createPrivateKey({
          key: Buffer.from(text.replace(/\s+/g, ''), 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
  } catch {
    throw new MessagingError(
      `${vendor}: the ${label} is not a valid private key; paste the whole key, including the BEGIN and END lines`,
      { code: 'INVALID_SETTINGS' },
    );
  }
  if (key.asymmetricKeyType !== type) {
    throw new MessagingError(
      `${vendor}: the ${label} is not ${type === 'rsa' ? 'an RSA' : 'an EC (P-256)'} key`,
      {
        code: 'INVALID_SETTINGS',
      },
    );
  }
  return key;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** Compact JWS: RS256 (Google service accounts) or ES256 (APNs, raw r||s signature). */
export function signJwt(
  header: Record<string, string>,
  claims: Record<string, unknown>,
  key: crypto.KeyObject,
): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature =
    header.alg === 'ES256'
      ? crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
      : crypto.sign('sha256', Buffer.from(input), key);
  return `${input}.${b64url(signature)}`;
}

/** Cache key for credentials without keeping them in clear in the map. */
export const credentialHash = (...parts: string[]) =>
  crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
