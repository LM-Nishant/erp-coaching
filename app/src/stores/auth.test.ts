import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { sessionEndSettled, setSessionExpiredHandler } from '@/core/api';
import { loadSession, saveSession } from '@/core/token-storage';
import type { MeDto, SignInProfileDto } from '@erp/shared';
import { useAuthStore } from './auth';

vi.mock('@/core/biometric', () => ({
  BiometricError: class extends Error {},
  biometricAvailability: async () => ({ available: false, label: '' }),
  disableBiometric: async () => undefined,
  enableBiometric: async () => null,
  exchangeUnlockSecret: async () => undefined,
  forgetBiometric: async () => undefined,
  getBiometricRecord: async () => null,
  readUnlockSecret: async () => '',
}));

vi.mock('@/core/device', () => ({
  getDeviceDescriptor: async () => ({ uid: 'device-0001', name: 'Test browser', platform: 'web' }),
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  setActivePinia(createPinia());
  setSessionExpiredHandler(async () => {
    await saveSession(null);
  });
  await saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('auth store session restore (init)', () => {
  it.each([
    ['a server error', () => json(503, { error: { code: 'UNAVAILABLE', message: 'Down' } })],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    [
      'a 403',
      () => json(403, { error: { code: 'INSTITUTE_NOT_ACTIVE', message: 'Institute is suspended' } }),
    ],
  ])('keeps the stored session after %s', async (_name, respond) => {
    vi.stubGlobal('fetch', vi.fn(respond));
    const auth = useAuthStore();
    await auth.restore();

    expect(auth.me).toBeNull();
    expect(await loadSession()).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
  });

  it('clears the session on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { error: { code: 'SESSION_REVOKED', message: 'Revoked' } })),
    );
    const auth = useAuthStore();
    await auth.restore();
    await sessionEndSettled();

    expect(auth.me).toBeNull();
    expect(await loadSession()).toBeNull();
  });
});

describe('auth store "Who\'s signing in?"', () => {
  const mobile = '9590000001';
  const institute = {
    id: 7,
    slug: 'demo',
    name: 'Demo Institute',
    logoUrl: null,
    primaryColor: null,
    secondaryColor: null,
  };
  const me = (id: number): MeDto => ({
    user: {
      id,
      name: `User ${id}`,
      mobile,
      email: null,
      isSuperAdmin: false,
      sharesMobile: id !== 1,
      profileCount: 2,
      locale: 'en',
    },
    institute,
    branches: [],
    allowedBranchIds: null,
    roles: ['student'],
    permissions: [],
    memberships: [{ ...institute, roles: ['student'] }],
    impersonatedBy: null,
    enabledModules: null,
  });
  const profiles: SignInProfileDto[] = [1, 2].map((id) => ({
    id,
    name: `User ${id}`,
    memberships: [
      {
        id: 7,
        name: 'Demo Institute',
        slug: 'demo',
        logoUrl: null,
        primaryColor: null,
        secondaryColor: null,
        roles: ['student'],
      },
    ],
  }));
  const chooseProfile = {
    status: 'choose_profile',
    selectionToken: 'selection-token',
    expiresIn: 300,
    profiles,
  };

  type Call = { route: string; body: Record<string, unknown> | undefined; token: string | null };
  /** Answers `METHOD /path` from `routes`; the access token of each call is the signed-in user's id (`a<id>`). */
  function stubApi(routes: Record<string, (body: Record<string, unknown> | undefined) => Response>) {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const route = `${init.method} ${new URL(url).pathname.replace(/^\/api/, '')}`;
        const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
        const token = (init.headers as Record<string, string>).Authorization?.replace('Bearer ', '') ?? null;
        calls.push({ route, body, token });
        if (route === 'GET /auth/me') return json(200, me(Number(token!.slice(1))));
        const answer = routes[route];
        if (!answer) throw new Error(`Unexpected ${route}`);
        return answer(body);
      }),
    );
    return calls;
  }
  const signedIn = {
    'POST /auth/select-profile': () =>
      json(200, { status: 'authenticated', accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 }),
  };

  it('keeps no session until a profile is chosen, then signs in as it', async () => {
    await saveSession(null);
    const calls = stubApi({
      'POST /auth/otp/verify': () => json(200, chooseProfile),
      ...signedIn,
    });
    const auth = useAuthStore();
    auth.pendingOtp = { challengeId: 'challenge-1', maskedMobile: '******0001', reason: 'otp_login' };

    expect(await auth.verifyOtp('123456')).toBe('choose-profile');
    expect(auth.pendingOtp).toBeNull();
    expect(auth.pendingProfiles).toMatchObject({ selectionToken: 'selection-token', profiles });
    expect(await loadSession()).toBeNull();

    expect(await auth.selectProfile(2)).toBe('home');
    expect(calls.find((c) => c.route === 'POST /auth/select-profile')).toMatchObject({
      token: null,
      body: { selectionToken: 'selection-token', userId: 2, device: { uid: 'device-0001' } },
    });
    expect(auth.me?.user.id).toBe(2);
    expect(auth.pendingProfiles).toBeNull();
    expect(await loadSession()).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', userId: 2 });
  });

  it('switches profile: a code to the shared number, then the previous account is signed out after the new one is in', async () => {
    const calls = stubApi({
      'POST /auth/otp/request': () =>
        json(200, {
          status: 'otp_required',
          challengeId: 'challenge-2',
          reason: 'otp_login',
          maskedMobile: '******0001',
        }),
      'POST /auth/otp/verify': () => json(200, chooseProfile),
      ...signedIn,
      'POST /auth/logout': () => new Response(null, { status: 204 }),
    });
    const auth = useAuthStore();
    await auth.fetchMe();

    expect(await auth.startProfileSwitch()).toBe('otp');
    expect(calls.at(-1)).toMatchObject({ route: 'POST /auth/otp/request', body: { mobile }, token: null });
    expect(await auth.verifyOtp('123456')).toBe('choose-profile');
    expect(auth.me?.user.id).toBe(1);
    expect(await auth.selectProfile(2)).toBe('home');

    expect(auth.me?.user.id).toBe(2);
    expect(await loadSession()).toMatchObject({ accessToken: 'a2', refreshToken: 'r2', userId: 2 });
    const routes = calls.map((c) => c.route);
    const logout = routes.indexOf('POST /auth/logout');
    expect(calls[logout]).toMatchObject({ body: { refreshToken: 'r1' }, token: null });
    expect(logout).toBeGreaterThan(routes.lastIndexOf('GET /auth/me'));
  });

  it('choosing the signed-in profile changes nothing', async () => {
    const calls = stubApi({});
    const auth = useAuthStore();
    await auth.fetchMe();
    auth.pendingProfiles = { selectionToken: 'selection-token', expiresAt: Date.now() + 300_000, profiles };

    expect(await auth.selectProfile(1)).toBe('home');
    expect(calls.map((c) => c.route)).toEqual(['GET /auth/me']);
    expect(auth.pendingProfiles).toBeNull();
    expect(await loadSession()).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
  });

  it('a profile at its device limit leaves the signed-in one and the choice open', async () => {
    const calls = stubApi({
      'POST /auth/select-profile': () => json(200, { status: 'device_limit_reached', maxDevices: 2 }),
    });
    const auth = useAuthStore();
    await auth.fetchMe();
    auth.pendingProfiles = { selectionToken: 'selection-token', expiresAt: Date.now() + 300_000, profiles };

    expect(await auth.selectProfile(2)).toBe('device-limit');
    expect(auth.me?.user.id).toBe(1);
    expect(auth.pendingProfiles?.selectionToken).toBe('selection-token');
    expect(await loadSession()).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
    expect(calls.map((c) => c.route)).not.toContain('POST /auth/logout');
  });

  it("never shows one account with the other's session when the switch fails half-way", async () => {
    const calls = stubApi({ ...signedIn, 'POST /auth/logout': () => new Response(null, { status: 204 }) });
    const auth = useAuthStore();
    await auth.fetchMe();
    auth.pendingProfiles = { selectionToken: 'selection-token', expiresAt: Date.now() + 300_000, profiles };
    const fetchMock = vi.mocked(fetch);
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      String(url).endsWith('/auth/me') ? Promise.reject(new TypeError('Failed to fetch')) : answer(url, init),
    );

    await expect(auth.selectProfile(2)).rejects.toThrow();
    expect(auth.me).toBeNull();
    expect(await loadSession()).toBeNull();
    expect(calls.find((c) => c.route === 'POST /auth/logout')?.body).toEqual({ refreshToken: 'r1' });
  });
});

describe('needsInstitute', () => {
  const me = (memberships: MeDto['memberships']) =>
    ({
      user: { id: 9, name: 'Learner', mobile: '9640000009', email: null, isSuperAdmin: false },
      institute: null,
      branches: [],
      allowedBranchIds: null,
      roles: [],
      permissions: [],
      memberships,
      impersonatedBy: null,
      enabledModules: null,
    }) as unknown as MeDto;

  it('asks institute members to choose one, but not marketplace-only accounts', () => {
    const auth = useAuthStore();
    auth.me = me([
      {
        id: 7,
        name: 'Demo Institute',
        slug: 'demo',
        logoUrl: null,
        primaryColor: null,
        secondaryColor: null,
        roles: ['student'],
      },
    ]);
    expect(auth.needsInstitute).toBe(true);
    auth.me = me([]);
    expect(auth.needsInstitute).toBe(false);
  });
});

describe('auth store hasStaffProfile', () => {
  it('follows the features the server reports, and assumes yes from an older server', () => {
    const auth = useAuthStore();
    expect(auth.hasStaffProfile).toBe(true);
    auth.me = { features: [] } as unknown as MeDto;
    expect(auth.hasStaffProfile).toBe(false);
    auth.me = { features: ['staff-profile'] } as unknown as MeDto;
    expect(auth.hasStaffProfile).toBe(true);
    auth.me = {} as MeDto;
    expect(auth.hasStaffProfile).toBe(true);
  });
});
