import { config } from '../config';
import { hmac, safeEqual } from '../crypto';

export interface SignedFileClaims {
  /** file id */
  f: number;
  /** institute id (null for platform files) */
  i: number | null;
  /** expiry (unix seconds) */
  e: number;
  /** device id, for a link bound to a device: it stops working once that device signs out or is revoked */
  d?: number;
}

/**
 * Short-lived HMAC token embedded in download URLs (usable in <img>/<video> tags). With `deviceId`, the
 * download route also checks that the device is still signed in (`isDeviceSignedIn`).
 */
export function signFileToken(
  fileId: number,
  instituteId: number | null,
  ttlSeconds = config.SIGNED_URL_TTL_SECONDS,
  deviceId?: number,
) {
  const claims: SignedFileClaims = {
    f: fileId,
    i: instituteId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
    ...(deviceId !== undefined && { d: deviceId }),
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
    if (claims.d !== undefined && typeof claims.d !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}
