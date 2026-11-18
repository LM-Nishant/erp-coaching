import type { ApiErrorBody, AuthTokens } from '@erp/shared';
import { loadSession, patchSession, saveSession, updateTokens } from './token-storage';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;
export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Skip auth header + refresh (login/OTP endpoints). */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** Extra request headers (e.g. `Idempotency-Key`). */
  headers?: Record<string, string>;
  /** Automatic poll, not a user action: does not keep the session alive (inactivity logout). */
  background?: boolean;
}

/** 401 codes a token refresh cannot fix: inactivity timeout, revoked device, deactivated account. */
export const SESSION_END_CODES: ReadonlySet<string> = new Set([
  'SESSION_IDLE',
  'SESSION_REVOKED',
  'ACCOUNT_INACTIVE',
]);

type SessionEndedHandler = (code: string) => void | Promise<void>;
/** Called with the API's error code once the session is over (main.ts locks the app or goes to login). */
let onSessionEnded: SessionEndedHandler | null = null;
export function setSessionExpiredHandler(fn: SessionEndedHandler) {
  onSessionEnded = fn;
}

let ending: Promise<void> | null = null;
/** Concurrent 401s end the session once. Also used when an anonymous call (biometric unlock) reports a revoked device. */
export function sessionEnded(code: string) {
  ending ??= (async () => {
    if (onSessionEnded) await onSessionEnded(code);
    else await saveSession(null);
  })()
    .catch(() => undefined)
    .finally(() => (ending = null));
  return ending;
}

/** Resolves once a session end in progress (including its handler) has finished. */
export const sessionEndSettled = () => ending ?? Promise.resolve();

async function errorCode(res: Response): Promise<string | undefined> {
  if (!res.headers.get('content-type')?.includes('application/json')) return undefined;
  try {
    return ((await res.clone().json()) as ApiErrorBody)?.error?.code;
  } catch {
    return undefined;
  }
}

let refreshing: Promise<{ ok: boolean; code?: string }> | null = null;

/** Single-flight refresh: concurrent 401s share one refresh call (refresh tokens rotate). */
async function refreshAccessToken(): Promise<{ ok: boolean; code?: string }> {
  refreshing ??= (async () => {
    const session = await loadSession();
    if (!session?.refreshToken || session.impersonator) return { ok: false };
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!res.ok) return { ok: false, code: await errorCode(res) };
    if (await updateTokens((await res.json()) as AuthTokens, session.refreshToken)) return { ok: true };
    // Signed out or signed in again during the refresh: retry with the current session, if any.
    return { ok: !!(await loadSession()) };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function buildUrl(path: string, query?: Query) {
  const url = new URL(`${API_URL}/api${path}`);
  Object.entries(query ?? {}).forEach(
    ([k, v]) => v !== undefined && v !== null && v !== '' && url.searchParams.set(k, String(v)),
  );
  return url.toString();
}

/** A request is re-sent at most this many times after a 401 (newer token, refresh, impersonation over). */
const MAX_RESENDS = 3;

/** `refreshed`: this request already triggered a token refresh (at most one per request). */
async function send(
  method: string,
  path: string,
  opts: RequestOptions,
  refreshed = false,
  resends = 0,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const isForm = opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (opts.background) headers['X-Background-Request'] = '1';
  const sent = opts.anonymous ? null : await loadSession();
  if (sent?.accessToken) headers.Authorization = `Bearer ${sent.accessToken}`;
  if (sent?.branchId) headers['X-Branch-Id'] = String(sent.branchId);
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    signal: opts.signal,
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status !== 401 || opts.anonymous) return res;
  const current = await loadSession();
  // Signed out (or the session already ended) while this request was in flight.
  if (!current) return res;
  const resend = (afterRefresh: boolean) =>
    resends < MAX_RESENDS ? send(method, path, opts, afterRefresh, resends + 1) : Promise.resolve(res);
  // Sent with an older token (refreshed, unlocked, signed in again or impersonation left meanwhile): retry with the
  // current one, which may still need its own refresh.
  if (current.accessToken !== sent?.accessToken) return resend(refreshed);
  let code = await errorCode(res);
  if (current.impersonator && code !== 'SESSION_REVOKED') {
    // The impersonation is over (expired, stopped, impersonated account deactivated): back to the super admin's own
    // session, refreshed if needed. Only a revoked device ends that session too.
    await patchSession(
      { ...current.impersonator, impersonator: null, branchId: null },
      (s) => s.accessToken === current.accessToken,
    );
    return resend(refreshed);
  }
  if (!refreshed && !SESSION_END_CODES.has(code ?? '')) {
    const r = await refreshAccessToken();
    if (r.ok) return resend(true);
    const session = await loadSession();
    if (!session) return res;
    if (session.accessToken !== sent?.accessToken) return resend(true);
    code = r.code ?? code;
  }
  void sessionEnded(code ?? 'UNAUTHORIZED');
  return res;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await send(method, path, opts);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the server at ${API_URL}`);
  }
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    const err = (data as ApiErrorBody)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: RequestOptions) => request<T>('GET', path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>('PATCH', path, { ...opts, body }),
  delete: <T = void>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
  /** Multipart upload to the storage service. Returns the file DTO plus a short-lived signed `url`. */
  upload: <T = UploadedFile>(
    file: Blob,
    fields: { module: string; branchId?: number; fileName?: string },
  ) => {
    const form = new FormData();
    form.append('module', fields.module);
    if (fields.branchId) form.append('branchId', String(fields.branchId));
    form.append('file', file, fields.fileName ?? (file as File).name ?? 'upload');
    return request<T>('POST', '/files', { body: form });
  },
};

export interface UploadedFile {
  id: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  module: string;
  url: string;
  expiresAt: string;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = e.details as { path: string; message: string }[] | undefined;
    if (e.code === 'VALIDATION_ERROR' && Array.isArray(issues) && issues.length)
      return issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    return e.message;
  }
  return (e as Error)?.message ?? 'Something went wrong';
}
