import os from 'node:os';
import pino from 'pino';
import { getContext } from '../shared/context';
import { config } from './config';

/** Secrets that travel in URLs (signed file/stream tokens, webhook keys, one-time codes). */
const SECRET_PATH = /\/(files\/signed|lms\/public\/hls|fees\/public\/webhooks\/[^/?]+)\/[^/?]+/g;
const SECRET_QUERY = /([?&](?:token|code|otp|key|signature|state)=)[^&]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_PATH, '/$1/[redacted]').replace(SECRET_QUERY, '$1[redacted]');
}

/**
 * JSON logs in production (one object per line for the log shipper). Every entry made while
 * handling a request or job carries its requestId and, once authenticated, instituteId/userId.
 */
export const logger = pino({
  level: config.isTest ? 'silent' : config.LOG_LEVEL,
  base: { pid: process.pid, hostname: os.hostname(), service: 'erp-api', version: config.APP_VERSION },
  mixin() {
    const { requestId, instituteId, userId } = getContext();
    return { requestId, instituteId, userId };
  },
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    '*.password',
    '*.apiKey',
    '*.refreshToken',
    '*.accessToken',
    '*.otp',
    '*.secret',
  ],
  transport:
    !config.isProd && !config.isTest ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
