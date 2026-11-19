import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { config } from '../../infrastructure/config';
import { AppError } from '../../shared/errors';
import { withContext } from '../../shared/middleware/context';
import { admsRateLimit } from '../../shared/middleware/security';
import {
  admitAdmsDevice,
  admsCommandResults,
  admsHandshakeReply,
  admsPing,
  admsPoll,
  admsSession,
  admsUpload,
  noteDeviceError,
  type AdmsCaller,
} from './adms.service';
import type { AttendanceDevice } from './models';

/**
 * ZKTeco/eSSL ADMS endpoints. Devices call `/iclock/<endpoint>` at the server root; app.ts rewrites
 * those paths to this router (`/api/attendance/public/iclock/...`). Replies are plain text.
 */

/** Firmware differs in parameter case (`SN`/`sn`, `Stamp`/`stamp`), so names match case-insensitively. */
function param(req: Request, name: string): string | undefined {
  for (const [key, value] of Object.entries(req.query)) {
    if (key.toLowerCase() !== name) continue;
    const v = Array.isArray(value) ? value[0] : value;
    return typeof v === 'string' ? v.trim() : undefined;
  }
  return undefined;
}

const callerOf = (req: Request): AdmsCaller => ({
  serial: param(req, 'sn') ?? '',
  ip: req.ip,
  secure: req.secure,
});

const device = (res: Response) => res.locals.admsDevice as AttendanceDevice;

function reply(res: Response, body: string) {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).type('text/plain').send(body);
}

/** Identifies the device before any body is read. */
const admit: RequestHandler = async (req, res, next) => {
  res.locals.admsDevice = await admitAdmsDevice(callerOf(req));
  next();
};

/** The whole body as bytes, whatever the content type (devices send text, or gzip data packets). */
const rawBody = withContext(express.raw({ type: () => true, limit: config.ADMS_MAX_BODY_KB * 1024 }));
const bodyOf = (req: Request): Buffer =>
  Buffer.isBuffer(req.body) ? req.body : (req.rawBody ?? Buffer.alloc(0));

/** Shows body-size refusals and server errors with the device, then answers as any API error. */
const noteErrors: ErrorRequestHandler = async (err, _req, res, next) => {
  const d = res.locals.admsDevice as AttendanceDevice | undefined;
  if (d && (err as { type?: string })?.type === 'entity.too.large')
    await noteDeviceError(d, `Refused an upload larger than ${config.ADMS_MAX_BODY_KB} KB`);
  else if (d && !(err instanceof AppError) && !(err as { type?: string })?.type)
    await noteDeviceError(d, 'Server error while processing a request from the device; it will retry');
  next(err);
};

export function admsRoutes(): Router {
  const r = Router();
  r.use(admsRateLimit);

  /** Handshake: upload pointers, clock offset and which data to push. */
  r.get('/cdata', admit, async (req, res) => {
    const caller = callerOf(req);
    reply(res, await admsSession(device(res), (d) => admsHandshakeReply(d, caller, param(req, 'pushver'))));
  });

  /** Uploads: attendance logs, user records, device settings (`fdata`: photos, acknowledged only). */
  r.post(['/cdata', '/fdata'], admit, rawBody, async (req, res) => {
    const caller = callerOf(req);
    const upload = {
      table: param(req, 'table') ?? '',
      stamp: param(req, 'stamp'),
      contentType: param(req, 'contenttype'),
      body: bodyOf(req),
    };
    reply(res, await admsSession(device(res), (d) => admsUpload(d, caller, upload)));
  });

  /** Command poll (every few seconds); also reports the device's counts in `INFO`. */
  r.get('/getrequest', admit, async (req, res) => {
    const caller = callerOf(req);
    reply(res, await admsSession(device(res), (d) => admsPoll(d, caller, param(req, 'info'))));
  });

  /** Command results. */
  r.post('/devicecmd', admit, rawBody, async (req, res) => {
    const caller = callerOf(req);
    const body = bodyOf(req).toString('utf8');
    reply(res, await admsSession(device(res), (d) => admsCommandResults(d, caller, body)));
  });

  r.get('/ping', admit, async (req, res) => {
    const caller = callerOf(req);
    reply(res, await admsSession(device(res), (d) => admsPing(d, caller)));
  });

  r.use(noteErrors);
  return r;
}
