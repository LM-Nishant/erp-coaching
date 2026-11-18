import type { ApiErrorBody, AuthTokens } from '@erp/shared';
import { loadSession, saveSession, updateTokens } from './token-storage';

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
}

/** Called when the session can no longer be refreshed (router redirects to login). */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

/** Called on every 402 (subscription restricted or suspended); the subscriptions module refreshes its banner. */
let onPaymentRequired: ((e: ApiError) => void) | null = null;
export function setPaymentRequiredHandler(fn: ((e: ApiError) => void) | null) {
  onPaymentRequired = fn;
}

let refreshing: Promise<boolean> | null = null;

/** Single-flight refresh: concurrent 401s share one refresh call (refresh tokens rotate). */
async function refreshAccessToken(): Promise<boolean> {
  refreshing ??= (async () => {
    const session = await loadSession();
    if (!session?.refreshToken || session.impersonator) return false;
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!res.ok) return false;
    await updateTokens((await res.json()) as AuthTokens);
    return true;
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

async function send(method: string, path: string, opts: RequestOptions, retried = false): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const isForm = opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (!opts.anonymous) {
    const session = await loadSession();
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
    if (session?.branchId) headers['X-Branch-Id'] = String(session.branchId);
  }
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    signal: opts.signal,
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !opts.anonymous && !retried) {
    if (await refreshAccessToken()) return send(method, path, opts, true);
    const session = await loadSession();
    if (session?.impersonator) {
      // Impersonation token expired: fall back to the super admin session.
      await saveSession({ ...session.impersonator, impersonator: null, branchId: null });
      return send(method, path, opts, true);
    }
    await saveSession(null);
    onSessionExpired?.();
  }
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
    const error = new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? res.statusText,
      err?.details,
    );
    if (res.status === 402) onPaymentRequired?.(error);
    throw error;
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
  /** Authenticated download of an endpoint that responds with a file attachment. */
  download: (path: string, query?: Query) => download(path, query),
};

export interface DownloadedFile {
  blob: Blob;
  /** From `Content-Disposition` when the browser may read it, otherwise null. */
  fileName: string | null;
}

async function download(path: string, query?: Query): Promise<DownloadedFile> {
  let res: Response;
  try {
    res = await send('GET', path, { query, headers: { Accept: '*/*' } });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the server at ${API_URL}`);
  }
  if (!res.ok) {
    const data = res.headers.get('content-type')?.includes('application/json')
      ? ((await res.json()) as ApiErrorBody)
      : null;
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.details);
  }
  const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? null;
  return { blob: await res.blob(), fileName };
}

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
