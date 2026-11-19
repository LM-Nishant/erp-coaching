import http2 from 'node:http2';
import nodemailer, { type SendMailOptions, type SMTPTransportOptions } from 'nodemailer';
import { config } from '../config';
import { MessagingError } from './errors';

/**
 * Network boundary of the vendor adapters: HTTPS (fetch), HTTP/2 (APNs) and SMTP. Tests replace it
 * with `setMessagingTransport` so no vendor is ever called from tests or CI.
 */
export interface Http2Response {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface Mailer {
  sendMail(mail: SendMailOptions): Promise<{ messageId: string; accepted: unknown[]; rejected: unknown[] }>;
  verify(): Promise<unknown>;
  close(): void;
}

export interface MessagingTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** One HTTP/2 POST (APNs); rejects on network errors and timeouts. */
  http2Request(
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<Http2Response>;
  createMailer(options: SMTPTransportOptions): Mailer;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Tests and CI never reach a vendor: the real transport only talks to local servers there. */
function assertLiveCallAllowed(host: string | undefined): void {
  if (config.isTest && !LOCAL_HOSTS.has((host ?? '').toLowerCase())) {
    throw new MessagingError(
      'Vendor calls are disabled in tests; install a mock with setMessagingTransport',
      {
        code: 'LIVE_CALLS_DISABLED',
      },
    );
  }
}

const defaults: MessagingTransport = {
  fetch: async (url, init) => {
    assertLiveCallAllowed(new URL(url).hostname);
    return fetch(url, init);
  },
  http2Request: async (origin, path, headers, body) => {
    assertLiveCallAllowed(new URL(origin).hostname);
    return defaultHttp2Request(origin, path, headers, body);
  },
  createMailer: (options) => {
    assertLiveCallAllowed(options.host);
    return nodemailer.createTransport(options);
  },
};
let current: MessagingTransport = defaults;

/** Tests: replace parts of the transport; `null` restores the real one. */
export function setMessagingTransport(overrides: Partial<MessagingTransport> | null): void {
  current = overrides ? { ...defaults, ...overrides } : defaults;
}

export const transport = (): MessagingTransport => current;

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  /** Parsed JSON body (null when the body is empty or not JSON). */
  json: unknown;
}

/** HTTPS call with the messaging timeout; network failures become transient `MessagingError`s. */
export async function vendorFetch(vendor: string, url: string, init: RequestInit): Promise<HttpResponse> {
  try {
    const res = await current.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(config.MESSAGING_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (err) {
    throw err instanceof MessagingError ? err : networkError(vendor, err);
  }
}

/** Timeouts and connection failures, without URLs (some vendors take the API key in the query). */
export function networkError(vendor: string, err: unknown): MessagingError {
  if (err instanceof MessagingError) return err;
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const reason =
    e.name === 'TimeoutError' || e.name === 'AbortError'
      ? 'timed out'
      : (e.cause?.code ?? e.code ?? 'network error');
  return new MessagingError(`${vendor} could not be reached (${reason})`, {
    code: 'NETWORK',
    transient: true,
  });
}

// ------------------------------------------------------------------ HTTP/2 (APNs)

/** APNs prefers long-lived connections: one session per origin, closed after a minute idle. */
const sessions = new Map<string, { session: http2.ClientHttp2Session; inflight: number }>();

function acquire(origin: string) {
  let entry = sessions.get(origin);
  if (!entry || entry.session.closed || entry.session.destroyed) {
    const session = http2.connect(origin);
    const forget = () => {
      if (sessions.get(origin)?.session === session) sessions.delete(origin);
    };
    // Errors also reach the pending streams; this listener keeps them from crashing the process.
    session.on('error', forget);
    session.on('close', forget);
    session.on('goaway', forget);
    session.setTimeout(60_000, () => session.close());
    session.unref();
    entry = { session, inflight: 0 };
    sessions.set(origin, entry);
  }
  if (entry.inflight++ === 0) entry.session.ref();
  return entry;
}

function release(entry: { session: http2.ClientHttp2Session; inflight: number }) {
  if (--entry.inflight === 0 && !entry.session.destroyed) entry.session.unref();
}

function defaultHttp2Request(
  origin: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<Http2Response> {
  return new Promise((resolve, reject) => {
    const entry = acquire(origin);
    let settled = false;
    let req: http2.ClientHttp2Stream | undefined;
    const timer = setTimeout(() => {
      finish(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
      req?.close(http2.constants.NGHTTP2_CANCEL);
    }, config.MESSAGING_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release(entry);
      fn();
    };
    try {
      req = entry.session.request({ ':method': 'POST', ':path': path, ...headers });
    } catch (err) {
      finish(() => reject(err));
      return;
    }
    let status = 0;
    const responseHeaders: Record<string, string | undefined> = {};
    const chunks: Buffer[] = [];
    req.on('response', (h) => {
      status = Number(h[':status']);
      for (const [k, v] of Object.entries(h))
        if (!k.startsWith(':')) responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v?.toString();
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () =>
      finish(() =>
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') }),
      ),
    );
    req.on('error', (err) => finish(() => reject(err)));
    req.on('close', () => finish(() => reject(new Error('stream closed'))));
    req.end(body);
  });
}
