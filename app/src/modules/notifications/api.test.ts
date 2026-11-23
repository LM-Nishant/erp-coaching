import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MeDto } from '@erp/shared';
import { useAuthStore } from '@/stores/auth';
import { inboxApi } from './api';
import { appModules } from '@/core/modules';

const calls = vi.hoisted(() => [] as string[]);
vi.mock('@/core/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    get: async (path: string) => (calls.push(`GET ${path}`), { unread: 0 }),
    post: async (path: string) => (calls.push(`POST ${path}`), {}),
    delete: async (path: string) => (calls.push(`DELETE ${path}`), undefined),
  },
}));

function signIn(me: Partial<MeDto> & { user: Partial<MeDto['user']> }) {
  useAuthStore().me = { institute: null, impersonatedBy: null, permissions: [], ...me } as unknown as MeDto;
}

const personalMenuItem = appModules
  .flatMap((m) => m.menu ?? [])
  .find((i) => i.path === '/notifications' && i.visible)!;

beforeEach(() => {
  setActivePinia(createPinia());
  calls.length = 0;
});

describe('notification inbox for users without an institute', () => {
  it('uses the personal inbox and shows its menu item', async () => {
    signIn({ user: { id: 1, isSuperAdmin: false } as MeDto['user'] });
    await inboxApi.unreadCount();
    await inboxApi.markRead(5);
    await inboxApi.removePushToken('t');
    expect(calls).toEqual([
      'GET /notifications/personal/inbox/unread-count',
      'POST /notifications/personal/inbox/5/read',
      'DELETE /notifications/personal/push-tokens',
    ]);
    expect(personalMenuItem.visible!()).toBe(true);
  });

  it.each([
    ['an institute member', { user: { id: 1, isSuperAdmin: false }, institute: { id: 2 } }],
    ['a platform admin', { user: { id: 1, isSuperAdmin: true } }],
  ])('keeps %s on the institute inbox', async (_name, me) => {
    signIn(me as unknown as MeDto);
    await inboxApi.unreadCount();
    expect(calls).toEqual(['GET /notifications/inbox/unread-count']);
    expect(personalMenuItem.visible!()).toBe(false);
  });

  it('removes a push token from the inbox it was registered with', async () => {
    signIn({
      user: { id: 1, isSuperAdmin: false } as MeDto['user'],
      institute: { id: 2 } as MeDto['institute'],
    });
    await inboxApi.removePushToken('t', true);
    expect(calls).toEqual(['DELETE /notifications/personal/push-tokens']);
  });
});
