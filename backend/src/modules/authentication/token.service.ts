import jwt from 'jsonwebtoken';
import { config } from '../../infrastructure/config';
import { Unauthorized } from '../../shared/errors';

export interface AccessClaims {
  sub: number;
  /** device row id */
  did: number;
  /** selected institute */
  inst?: number;
  /** impersonating super admin id */
  imp?: number;
  /** impersonation session id */
  isid?: number;
}

export function signAccessToken(claims: AccessClaims, ttlSeconds = config.ACCESS_TOKEN_TTL_SECONDS): string {
  return jwt.sign({ ...claims, typ: 'access' }, config.JWT_ACCESS_SECRET, {
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload &
      AccessClaims & { typ?: string };
    if (payload.typ !== 'access' || typeof payload.sub !== 'number') throw new Error('bad token');
    return { sub: payload.sub, did: payload.did, inst: payload.inst, imp: payload.imp, isid: payload.isid };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw Unauthorized('Access token expired', 'TOKEN_EXPIRED');
    throw Unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
}
