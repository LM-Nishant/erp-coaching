/**
 * Thin JSON client for the API (http://localhost:<E2E_API_PORT>/api) and login helpers that mirror
 * the app: password login with the new-device OTP step, and mobile OTP login. OTPs are read from
 * the outbox file.
 */
import crypto from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { API_URL } from './env';
import { outboxMark, waitForOtp } from './outbox';

export interface Device {
  uid: string;
  name: string;
  platform: 'web';
}

/** A device the API has never seen (each Playwright browser context is also a new device). */
export function newDevice(label: string): Device {
  return { uid: `e2e-${label}-${crypto.randomUUID()}`.slice(0, 128), name: `E2E ${label}`, platform: 'web' };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class Api {
  constructor(
    readonly http: APIRequestContext,
    readonly token?: string,
  ) {}

  /** Sends a JSON request to `/api${path}` and returns the parsed body; throws ApiError unless 2xx. */
  async request<T>(method: Method, path: string, data?: unknown): Promise<T> {
    const response = await this.http.fetch(`${API_URL}/api${path}`, {
      method,
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      data,
      failOnStatusCode: false,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok())
      throw new ApiError(
        response.status(),
        body,
        `${method} ${path} → ${response.status()} ${text.slice(0, 500)}`,
      );
    return body as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, data: unknown = {}) {
    return this.request<T>('POST', path, data);
  }
  put<T>(path: string, data: unknown = {}) {
    return this.request<T>('PUT', path, data);
  }
  patch<T>(path: string, data: unknown = {}) {
    return this.request<T>('PATCH', path, data);
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export type LoginResponse =
  | ({ status: 'authenticated' } & Tokens)
  | { status: 'otp_required'; challengeId: string }
  | { status: 'device_limit_reached'; maxDevices: number };

export interface Me {
  user: { id: number; name: string; mobile: string; isSuperAdmin: boolean };
  institute: { id: number; name: string; slug: string } | null;
  roles: string[];
}

/** A signed-in user on one device: use `api` for setup calls, or open the app as them (fixtures). */
export interface Session extends Tokens {
  device: Device;
  user: Me['user'];
  api: Api;
}

async function toSession(http: APIRequestContext, device: Device, result: LoginResponse): Promise<Session> {
  if (result.status !== 'authenticated') throw new Error(`Login did not complete: ${JSON.stringify(result)}`);
  const api = new Api(http, result.accessToken);
  const me = await api.get<Me>('/auth/me');
  return { device, accessToken: result.accessToken, refreshToken: result.refreshToken, user: me.user, api };
}

/** Password login; completes the new-device OTP step (via the outbox) when the API asks for it. */
export async function loginWithPassword(
  http: APIRequestContext,
  credentials: { mobile: string; password: string },
  device: Device = newDevice('api'),
): Promise<Session> {
  const anonymous = new Api(http);
  const since = outboxMark();
  let result = await anonymous.post<LoginResponse>('/auth/login', {
    identifier: credentials.mobile,
    password: credentials.password,
    device,
  });
  if (result.status === 'otp_required') {
    const code = await waitForOtp(credentials.mobile, since);
    result = await anonymous.post<LoginResponse>('/auth/otp/verify', {
      challengeId: result.challengeId,
      code,
      device,
    });
  }
  return toSession(http, device, result);
}

/** Mobile OTP login (e.g. guardians, who are created without a password). */
export async function loginWithOtp(
  http: APIRequestContext,
  mobile: string,
  device: Device = newDevice('api'),
): Promise<Session> {
  const anonymous = new Api(http);
  const since = outboxMark();
  const challenge = await anonymous.post<LoginResponse>('/auth/otp/request', { mobile, device });
  if (challenge.status !== 'otp_required')
    throw new Error(`Unexpected OTP response: ${JSON.stringify(challenge)}`);
  const code = await waitForOtp(mobile, since);
  const result = await anonymous.post<LoginResponse>('/auth/otp/verify', {
    challengeId: challenge.challengeId,
    code,
    device,
  });
  return toSession(http, device, result);
}
