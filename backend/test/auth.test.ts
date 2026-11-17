import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, getApp, lastOtpFor, login, newDevice } from './helpers';

// Dedicated user so device-limit assertions are not affected by other test files.
const ACCOUNTANT = { mobile: '9100000003', password: 'Password@123' };

describe('authentication', () => {
  beforeAll(async () => {
    await getApp();
  });

  it('rejects wrong passwords', async () => {
    const res = await request(await getApp())
      .post('/api/auth/login')
      .send({ identifier: ACCOUNTANT.mobile, password: 'nope-nope', device: newDevice() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('first device logs in directly; a new device requires OTP; max 2 active devices', async () => {
    const app = await getApp();
    const first = newDevice();
    const r1 = await request(app)
      .post('/api/auth/login')
      .send({ identifier: ACCOUNTANT.mobile, password: ACCOUNTANT.password, device: first });
    expect(r1.body.status).toBe('authenticated');

    const second = newDevice('android');
    const r2 = await request(app)
      .post('/api/auth/login')
      .send({ identifier: ACCOUNTANT.mobile, password: ACCOUNTANT.password, device: second });
    expect(r2.body).toMatchObject({ status: 'otp_required', reason: 'new_device' });

    const wrong = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: r2.body.challengeId, code: '000000', device: second });
    expect(wrong.status).toBe(401);
    // OTP is bound to the device that requested it.
    const otherDevice = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: r2.body.challengeId, code: lastOtpFor(ACCOUNTANT.mobile), device: newDevice() });
    expect(otherDevice.status).toBe(401);

    const ok = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: r2.body.challengeId, code: lastOtpFor(ACCOUNTANT.mobile), device: second });
    expect(ok.body.status).toBe('authenticated');

    const third = await request(app)
      .post('/api/auth/login')
      .send({ identifier: ACCOUNTANT.mobile, password: ACCOUNTANT.password, device: newDevice('ios') });
    expect(third.body).toMatchObject({ status: 'device_limit_reached', maxDevices: 2 });

    // Revoking a device frees a slot and kills its sessions.
    const devices = await request(app).get('/api/auth/devices').set(bearer(ok.body.accessToken));
    const firstRow = devices.body.find((d: { current: boolean }) => !d.current);
    await request(app)
      .delete(`/api/auth/devices/${firstRow.id}`)
      .set(bearer(ok.body.accessToken))
      .expect(204);
    const revokedUse = await request(app).get('/api/auth/me').set(bearer(r1.body.accessToken));
    expect(revokedUse.status).toBe(401);
  });

  it('OTP login works and auto-selects the only institute', async () => {
    const app = await getApp();
    const user = { mobile: '9100000006' };
    const device = newDevice();
    const req = await request(app).post('/api/auth/otp/request').send({ mobile: user.mobile, device });
    expect(req.body.status).toBe('otp_required');
    const res = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: req.body.challengeId, code: lastOtpFor(user.mobile), device });
    expect(res.body.status).toBe('authenticated');
    const me = await request(app).get('/api/auth/me').set(bearer(res.body.accessToken));
    expect(me.body.institute.slug).toBe('apex');
    expect(me.body.roles).toEqual(['parent']);
  });

  it('OTP request does not reveal unknown numbers', async () => {
    const res = await request(await getApp())
      .post('/api/auth/otp/request')
      .send({ mobile: '9999999999', device: newDevice() });
    expect(res.body.status).toBe('otp_required');
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const app = await getApp();
    const s = await login({ mobile: '9100000001', password: 'Password@123' });
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(reuse.status).toBe(401);
    // Reuse revokes the whole token family for that device.
    const after = await request(app).post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(after.status).toBe(401);
  });
});
