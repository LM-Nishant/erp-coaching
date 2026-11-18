import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { sessionEndSettled, setSessionExpiredHandler } from '@/core/api';
import { loadSession, saveSession } from '@/core/token-storage';
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
