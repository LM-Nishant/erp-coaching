import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { Op } from 'sequelize';
import { Device } from '../../../modules/authentication/models';
import { signAccessToken } from '../../../modules/authentication/token.service';

/** Device uid prefix of the throwaway devices the demo seed signs its API calls with. */
export const DEMO_DEVICE_PREFIX = 'demo-seed-';

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body).slice(0, 600)}`);
  }
}

export interface Caller {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Same caller acting in one branch (X-Branch-Id). */
  inBranch(branchId: number): Caller;
}

/**
 * Drives the real HTTP API in-process, so the demo data goes through the same validation, ledgers
 * and hooks as data entered in the app. Each user gets a temporary device row (deleted by `close`):
 * keeping it would make the demo logins ask for an OTP on their next password login.
 */
export class DemoApi {
  private server: Server | null = null;
  private base = '';
  private devices = new Map<number, number>();

  constructor(private readonly app: Express) {}

  async start() {
    this.server = await new Promise<Server>((resolve) => {
      const s = this.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
  }

  async as(userId: number, instituteId: number): Promise<Caller> {
    let did = this.devices.get(userId);
    if (!did) {
      const [device] = await Device.findOrCreate({
        where: { userId, deviceUid: `${DEMO_DEVICE_PREFIX}${userId}` },
        defaults: {
          userId,
          deviceUid: `${DEMO_DEVICE_PREFIX}${userId}`,
          name: 'Demo data seed',
          platform: 'web',
          lastSeenAt: null,
          lastIp: null,
          revokedAt: null,
          revokedBy: null,
        },
      });
      if (device.status !== 'active') await device.update({ status: 'active', revokedAt: null });
      did = device.id;
      this.devices.set(userId, did);
    }
    const token = signAccessToken({ sub: userId, did, inst: instituteId }, 3600);
    return this.caller(token);
  }

  private caller(token: string, branchId?: number): Caller {
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (branchId) headers['x-branch-id'] = String(branchId);
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!res.ok) throw new ApiError(method, path, res.status, parsed);
      return parsed as T;
    };
    return {
      get: <T>(p: string) => call<T>('GET', p),
      post: <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
      put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b ?? {}),
      patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b ?? {}),
      inBranch: (id) => this.caller(token, id),
    };
  }

  async close() {
    await Device.destroy({ where: { deviceUid: { [Op.like]: `${DEMO_DEVICE_PREFIX}%` } } });
    this.devices.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
