import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, sessionEndSettled, setPaymentRequiredHandler, setSessionExpiredHandler } from './api';
import { loadSession, saveSession } from './token-storage';

type Route = (req: { path: string; token: string | null; headers: Record<string, string> }) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthorized = (code: string) => json(401, { error: { code, message: code } });

let calls: { path: string; token: string | null; headers: Record<string, string> }[];
function serve(route: Route) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const req = {
        path: new URL(url).pathname.replace(/^\/api/, ''),
        token: headers.Authorization?.replace('Bearer ', '') ?? null,
        headers,
      };
      calls.push(req);
      return route(req);
    }),
  );
}

const onEnded = vi.fn(async () => {
  await saveSession(null);
});

beforeEach(async () => {
  onEnded.mockClear();
  setSessionExpiredHandler(onEnded);
  await saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api session handling', () => {
  it('ends the session once, without a refresh, when the server reports inactivity or a revoked device', async () => {
    serve(() => unauthorized('SESSION_IDLE'));
    const results = await Promise.allSettled([api.get('/a'), api.get('/b'), api.post('/c')]);
    await sessionEndSettled();

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(onEnded).toHaveBeenCalledExactlyOnceWith('SESSION_IDLE');
    expect(calls.some((c) => c.path === '/auth/refresh')).toBe(false);
    expect(await loadSession()).toBeNull();
  });

  it('refreshes an expired token once for concurrent requests; polls are flagged as background', async () => {
    serve(({ path, token }) => {
      if (path === '/auth/refresh') return json(200, { accessToken: 'a2', refreshToken: 'r2' });
      return token === 'a2' ? json(200, { ok: path }) : unauthorized('TOKEN_EXPIRED');
    });
    const [page, poll] = await Promise.all([
      api.get('/page'),
      api.get('/notifications/inbox/unread-count', undefined, { background: true }),
    ]);

    expect([page, poll]).toEqual([{ ok: '/page' }, { ok: '/notifications/inbox/unread-count' }]);
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
    expect(await loadSession()).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    expect(calls.filter((c) => c.headers['X-Background-Request'] === '1').map((c) => c.path)).toEqual([
      '/notifications/inbox/unread-count',
      '/notifications/inbox/unread-count',
    ]);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('retries a request sent with the old token after an unlock or a new sign-in instead of ending the new session', async () => {
    serve(({ token }) => {
      if (token !== 'a1') return json(200, { ok: token });
      // The app was unlocked while this request was in flight: the server rejects the old session.
      void saveSession({ accessToken: 'b1', refreshToken: 'rb', userId: 1 });
      return unauthorized('SESSION_IDLE');
    });

    expect(await api.get('/x')).toEqual({ ok: 'b1' });
    await sessionEndSettled();
    expect(onEnded).not.toHaveBeenCalled();
    expect(await loadSession()).toMatchObject({ accessToken: 'b1' });
  });

  const impersonating = () =>
    saveSession({
      accessToken: 'imp',
      refreshToken: null,
      userId: 1,
      branchId: 5,
      impersonator: { accessToken: 'sa1', refreshToken: 'rs1' },
    });

  it.each(['IMPERSONATION_ENDED', 'ACCOUNT_INACTIVE'])(
    'returns to the super admin session, refreshed once, when an impersonation gets %s',
    async (code) => {
      await impersonating();
      serve(({ path, token }) => {
        if (path === '/auth/refresh') return json(200, { accessToken: 'sa2', refreshToken: 'rs2' });
        if (token === 'imp') return unauthorized(code);
        return token === 'sa2' ? json(200, { ok: path }) : unauthorized('TOKEN_EXPIRED');
      });

      expect(await Promise.all([api.get('/a'), api.get('/b')])).toEqual([{ ok: '/a' }, { ok: '/b' }]);
      await sessionEndSettled();
      expect(onEnded).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
      expect(await loadSession()).toEqual({
        accessToken: 'sa2',
        refreshToken: 'rs2',
        userId: 1,
        branchId: null,
        impersonator: null,
      });
    },
  );

  it('ends the session when the device is revoked during an impersonation', async () => {
    await impersonating();
    serve(() => unauthorized('SESSION_REVOKED'));

    await expect(api.get('/a')).rejects.toMatchObject({ status: 401, code: 'SESSION_REVOKED' });
    await sessionEndSettled();
    expect(onEnded).toHaveBeenCalledExactlyOnceWith('SESSION_REVOKED');
    expect(calls.map((c) => c.token)).toEqual(['imp']);
  });
});

describe('api.download session and subscription handling', () => {
  const file = () => new Response('a,b\n', { headers: { 'content-type': 'text/csv' } });
  afterEach(() => setPaymentRequiredHandler(null));

  it('refreshes an expired token and retries the download like JSON requests', async () => {
    serve(({ path, token }) => {
      if (path === '/auth/refresh') return json(200, { accessToken: 'a2', refreshToken: 'r2' });
      return token === 'a2' ? file() : unauthorized('TOKEN_EXPIRED');
    });
    const res = await api.download('/reports/x/export');

    expect(await res.blob.text()).toBe('a,b\n');
    expect(calls.map((c) => [c.path, c.token])).toEqual([
      ['/reports/x/export', 'a1'],
      ['/auth/refresh', null],
      ['/reports/x/export', 'a2'],
    ]);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it.each(['SESSION_REVOKED', 'SESSION_IDLE'])(
    'ends the session without a refresh on 401 %s',
    async (code) => {
      serve(() => unauthorized(code));
      await expect(api.download('/reports/x/export')).rejects.toMatchObject({ status: 401, code });
      await sessionEndSettled();

      expect(onEnded).toHaveBeenCalledExactlyOnceWith(code);
      expect(calls.some((c) => c.path === '/auth/refresh')).toBe(false);
      expect(await loadSession()).toBeNull();
    },
  );

  it('reports a 402 to the payment-required handler, for downloads and JSON requests alike', async () => {
    const onPayment = vi.fn();
    setPaymentRequiredHandler(onPayment);
    serve(() => json(402, { error: { code: 'SUBSCRIPTION_SUSPENDED', message: 'Suspended' } }));

    await expect(api.download('/reports/x/export')).rejects.toMatchObject({
      status: 402,
      code: 'SUBSCRIPTION_SUSPENDED',
    });
    await expect(api.get('/students')).rejects.toMatchObject({ status: 402 });
    expect(onPayment).toHaveBeenCalledTimes(2);
    expect(onPayment.mock.calls[0]![0]).toMatchObject({ code: 'SUBSCRIPTION_SUSPENDED' });
    expect(await loadSession()).toMatchObject({ accessToken: 'a1' });
  });
});
