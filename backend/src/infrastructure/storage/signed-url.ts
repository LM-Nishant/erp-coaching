import { config } from '../config';
import { hmac, safeEqual } from '../crypto';

export interface SignedFileClaims {
  /** file id */
  f: number;
  /** institute id (null for platform files) */
  i: number | null;
  /** expiry (unix seconds) */
  e: number;
}

/** Short-lived HMAC token embedded in download URLs (usable in <img>/<video> tags). */
export function signFileToken(
  fileId: number,
  instituteId: number | null,
  ttlSeconds = config.SIGNED_URL_TTL_SECONDS,
) {
  const claims: SignedFileClaims = {
    f: fileId,
    i: instituteId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${body}.${hmac(body, config.FILE_URL_SECRET)}`, expiresAt: new Date(claims.e * 1000) };
}

export function verifyFileToken(token: string): SignedFileClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body, config.FILE_URL_SECRET))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as SignedFileClaims;
    if (typeof claims.f !== 'number' || claims.e < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}
