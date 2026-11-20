import { describe, expect, it } from 'vitest';
import { appModules } from '@/core/modules';

const routes = appModules.flatMap((m) => [...(m.publicRoutes ?? []), ...(m.routes ?? [])]);

describe('pages reachable while the subscription is suspended', () => {
  it.each([
    'login',
    'otp',
    'choose-profile',
    'unlock',
    'select-institute',
    'forbidden',
    'devices',
    'member-devices',
    'subscription-billing',
    'subscription-suspended',
    'tenant-data',
  ])('%s is marked allowWhenSuspended', (name) => {
    expect(routes.find((r) => r.name === name)?.meta?.allowWhenSuspended).toBe(true);
  });

  it('keeps institute data pages blocked', () => {
    for (const name of ['home', 'branches', 'students'])
      expect(routes.find((r) => r.name === name)?.meta?.allowWhenSuspended).toBeFalsy();
  });
});

describe('menu items', () => {
  it('show Offline lectures to everyone who may view LMS content', () => {
    const item = appModules.flatMap((m) => m.menu ?? []).find((i) => i.path === '/lms/offline');
    expect(item?.permission).toBe('lms.view');
  });
});
