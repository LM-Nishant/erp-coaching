import crypto from 'node:crypto';
import { GatewayRequestError, type PaymentGatewayName } from './types';

export interface GatewayHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface GatewayHttpResponse {
  status: number;
  body: string;
}

/** Transport used for every vendor API call. Tests replace it with `setPaymentGatewayHttp`. */
export type GatewayHttp = (req: GatewayHttpRequest) => Promise<GatewayHttpResponse>;

export const GATEWAY_LABELS: Record<PaymentGatewayName, string> = {
  mock: 'Mock gateway',
  paytm: 'Paytm',
  razorpay: 'Razorpay',
  cashfree: 'Cashfree',
};

const TIMEOUT_MS = 20_000;
let override: GatewayHttp | null = null;

/** Routes vendor calls through `fn` (tests mock HTTP here); `null` restores the real transport. */
export function setPaymentGatewayHttp(fn: GatewayHttp | null): void {
  override = fn;
}

const fetchTransport: GatewayHttp = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
};

export interface GatewayJsonResponse {
  status: number;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
}

/**
 * Sends one vendor request. Network failures, timeouts, 429 and 5xx become retryable
 * `GatewayRequestError`s; other statuses are returned for the adapter to interpret. Requests carry
 * credentials, so neither requests nor raw responses are logged here.
 */
export async function gatewayRequest(
  gateway: PaymentGatewayName,
  req: GatewayHttpRequest,
): Promise<GatewayJsonResponse> {
  const label = GATEWAY_LABELS[gateway];
  if (!override && process.env.NODE_ENV === 'test')
    throw new Error(`Live ${label} calls are disabled in tests: mock them with setPaymentGatewayHttp()`);
  let res: GatewayHttpResponse;
  try {
    res = await (override ?? fetchTransport)(req);
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new GatewayRequestError(
      gateway,
      timedOut ? `${label} did not respond in time` : `Could not reach ${label}`,
      { code: timedOut ? 'timeout' : 'network', retryable: true },
    );
  }
  let json: unknown = null;
  if (res.body) {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = null;
    }
  }
  if (res.status === 429 || res.status >= 500)
    throw new GatewayRequestError(gateway, `${label} is temporarily unavailable (HTTP ${res.status})`, {
      status: res.status,
      retryable: true,
    });
  return { status: res.status, json };
}

/** Vendor text shown to admins: single line, bounded. */
export function vendorText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 200) : fallback;
}

export function rupees(amountPaise: number): string {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new RangeError('Invalid amount');
  return (amountPaise / 100).toFixed(2);
}

/** Rupee amount (number or decimal string) to paise. */
export function paise(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Order IDs vendors accept: our reference plus a random suffix, so re-created databases never collide. */
export function vendorOrderId(orderId: string, maxLength: number, allowed: RegExp): string {
  const suffix = `_${crypto.randomBytes(3).toString('hex')}`;
  const base = [...orderId].filter((c) => allowed.test(c)).join('') || 'order';
  return base.slice(0, maxLength - suffix.length) + suffix;
}

/** Last 10 digits of an Indian mobile number (vendors reject +91 / spaces). */
export function tenDigitMobile(mobile: string): string {
  return mobile.replace(/\D/g, '').slice(-10);
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const v = headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function looksLikeEmail(email: string | undefined): email is string {
  return !!email && email.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Customer reference vendors accept (letters, digits, `_`, `-`; 3–50 characters). */
export function customerRef(id: string | undefined, mobile: string): string {
  const clean = (id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50);
  return clean.length >= 3 ? clean : `cust_${tenDigitMobile(mobile) || 'guest'}`;
}

export function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}
