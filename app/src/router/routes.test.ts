import { describe, expect, it } from 'vitest';
import { appModules, fitsPersona } from '@/core/modules';

const routes = appModules.flatMap((m) => [...(m.publicRoutes ?? []), ...(m.routes ?? [])]);
const menu = appModules.flatMap((m) => m.menu ?? []);

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
    const item = menu.find((i) => i.path === '/lms/offline');
    expect(item?.permission).toBe('lms.view');
    expect(item?.roles).toBeUndefined();
  });

  it.each([
    ['institute-admin', []],
    ['branch-admin', []],
    ['accountant', []],
    ['teacher', ['My availability', 'My timetable']],
    ['student', ['Check in', 'My courses', 'My timetable']],
    ['parent', ['My courses']],
  ])('show %s only the persona pages meant for it', (role, titles) => {
    const persona = menu.filter((i) => i.roles && fitsPersona(i, [role]));
    expect(persona.map((i) => i.title).sort()).toEqual(titles);
  });

  it('show persona pages to a user holding any one of their roles', () => {
    const timetable = menu.find((i) => i.path === '/my-timetable')!;
    expect(fitsPersona(timetable, ['parent', 'teacher'])).toBe(true);
    expect(fitsPersona(timetable, [])).toBe(false);
  });
});
