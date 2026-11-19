import type { IncomingMessage } from 'node:http';
import express, { type RequestHandler } from 'express';

/** Keeps the exact bytes so payment webhooks can verify vendor signatures. */
const keepRawBody = (req: IncomingMessage, _res: unknown, buf: Buffer) => {
  (req as express.Request).rawBody = buf;
};

const ownBodyPaths = new Set<string>();
// Express matches routes case-insensitively and with an optional trailing slash.
const normalise = (path: string) => path.toLowerCase().replace(/\/+$/, '');

const defaultJson = express.json({ limit: '1mb', verify: keepRawBody });

/** Parses JSON bodies up to 1 MB, except on routes that parse their own body (`ownJsonBody`). */
export const jsonBody: RequestHandler = (req, res, next) => {
  if (ownBodyPaths.has(normalise(req.path))) return next();
  return defaultJson(req, res, next);
};

/**
 * For public routes that should read the body only after authenticating the caller, and with a
 * smaller limit: the global parser skips `path` (the full path, e.g. `/api/x/y`), and the returned
 * parser goes in the route's middleware chain. Larger bodies get 413 PAYLOAD_TOO_LARGE before any
 * parsing (straight away when `Content-Length` says so).
 */
export function ownJsonBody(path: string, limitBytes: number): RequestHandler {
  ownBodyPaths.add(normalise(path));
  return express.json({ limit: limitBytes, verify: keepRawBody });
}
