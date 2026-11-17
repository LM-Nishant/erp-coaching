import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrap } from '../src/bootstrap';
import { createApp } from '../src/app';
import { consoleOutbox } from '../src/infrastructure/messaging/console.provider';

let app: Express | null = null;

export async function getApp(): Promise<Express> {
  if (!app) app = createApp(await bootstrap()) as Express;
  return app;
}

export const DEMO_PASSWORD = 'Password@123';
/** Seeded users: 91… = Apex, 92… = Zenith; suffix 1 admin, 2 branch admin, 3 accountant, 4 teacher, 5 student, 6 parent. */
export const USERS = {
  superAdmin: { mobile: '9000000000', password: 'Admin@12345' },
  apexAdmin: { mobile: '9100000001', password: DEMO_PASSWORD },
  apexBranchAdmin: { mobile: '9100000002', password: DEMO_PASSWORD },
  apexTeacher: { mobile: '9100000004', password: DEMO_PASSWORD },
  zenithAdmin: { mobile: '9200000001', password: DEMO_PASSWORD },
};

/** Same device per user across the run, so only the very first login registers a device. */
export const stableDevice = (mobile: string) => ({ uid: `test-device-${mobile}`, platform: 'web' as const });
export const newDevice = (platform: 'web' | 'android' | 'ios' = 'web') => ({
  uid: `test-${crypto.randomUUID()}`,
  platform,
});

export function lastOtpFor(mobile: string): string {
  const msg = [...consoleOutbox].reverse().find((m) => m.to === mobile && m.data?.otp);
  if (!msg) throw new Error(`No OTP sent to ${mobile}`);
  return String(msg.data!.otp);
}

/** Logs in with password, completing the new-device OTP step if required. */
export async function login(user: { mobile: string; password: string }, device = stableDevice(user.mobile)) {
  const a = await getApp();
  let res = await request(a)
    .post('/api/auth/login')
    .send({ identifier: user.mobile, password: user.password, device });
  if (res.body.status === 'otp_required') {
    res = await request(a)
      .post('/api/auth/otp/verify')
      .send({ challengeId: res.body.challengeId, code: lastOtpFor(user.mobile), device });
  }
  if (res.body.status !== 'authenticated') throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.accessToken as string,
    refreshToken: res.body.refreshToken as string,
    device,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
