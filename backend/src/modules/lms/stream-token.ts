import { config } from '../../infrastructure/config';
import { hmac, safeEqual } from '../../infrastructure/crypto';

/** Claims of a short-lived HLS playback token: covers one resource's playlist and segments for one user. */
export interface StreamClaims {
  /** resource id */
  r: number;
  /** institute id */
  i: number;
  /** user id */
  u: number;
  /** expiry (unix seconds) */
  e: number;
}

const secret = () => `${config.FILE_URL_SECRET}:lms-stream`;

export function signStreamToken(resourceId: number, instituteId: number, userId: number, ttlSeconds: number) {
  const claims: StreamClaims = {
    r: resourceId,
    i: instituteId,
    u: userId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `${body}.${hmac(body, secret())}`, expiresAt: new Date(claims.e * 1000) };
}

export function verifyStreamToken(token: string): StreamClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body, secret()))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as StreamClaims;
    if (typeof c.r !== 'number' || typeof c.i !== 'number' || c.e < Date.now() / 1000) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * Playback links stay short-lived but must outlast the video, because the player keeps requesting
 * ranges/segments while it plays. The app asks for a fresh link (and resumes) when one expires.
 */
export function playbackTtlSeconds(durationSeconds: number | null): number {
  const base = config.SIGNED_URL_TTL_SECONDS;
  const wanted = (durationSeconds ?? 3600) + 900;
  return Math.min(Math.max(base, wanted), 6 * 3600);
}
