import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.isTest ? 'silent' : config.LOG_LEVEL,
  redact: ['req.headers.authorization', '*.password', '*.apiKey', '*.refreshToken'],
  transport:
    !config.isProd && !config.isTest ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
