import { describe, expect, it } from 'vitest';
import { fitsPersona, groupMenu, tabsFor, type MenuItem } from './modules';
import { personaOf } from './persona';

const inst = (...roles: string[]) => personaOf({ isPlatformAdmin: false, hasInstitute: true, roles });

describe('personaOf', () => {
  it('maps system roles to personas', () => {
    expect(inst('student')).toBe('student');
    expect(inst('parent')).toBe('parent');
    expect(inst('teacher')).toBe('teacher');
    expect(inst('institute-admin')).toBe('staff');
    expect(inst('branch-admin')).toBe('staff');
    expect(inst('accountant')).toBe('staff');
  });

  it('treats custom roles (front desk) as staff', () => {
    expect(inst('front-desk')).toBe('staff');
    expect(inst()).toBe('staff');
  });

  it('picks the most capable persona when a user has several roles', () => {
    expect(inst('parent', 'teacher')).toBe('teacher');
    expect(inst('teacher', 'accountant')).toBe('staff');
    expect(inst('parent', 'student')).toBe('student');
  });

  it('knows platform admins and users without an institute', () => {
    expect(personaOf({ isPlatformAdmin: true, hasInstitute: false, roles: [] })).toBe('platform');
    expect(personaOf({ isPlatformAdmin: false, hasInstitute: false, roles: [] })).toBe('learner');
  });
});

const item = (path: string, extra: Partial<MenuItem> = {}): MenuItem => ({
  title: path,
  path,
  icon: '',
  ...extra,
});

describe('menu helpers', () => {
  it('fitsPersona checks personas only when both sides say so', () => {
    const parentsOnly = item('/a', { personas: ['parent'] });
    expect(fitsPersona(parentsOnly, [], 'parent')).toBe(true);
    expect(fitsPersona(parentsOnly, [], 'student')).toBe(false);
    expect(fitsPersona(parentsOnly, [])).toBe(true);
    expect(
      fitsPersona(item('/b', { roles: ['teacher'], personas: ['teacher'] }), ['student'], 'teacher'),
    ).toBe(false);
  });

  it('tabsFor keeps the lowest positions for the persona, leaving room for More', () => {
    const items = [
      item('/e', { tab: { student: 5 } }),
      item('/b', { tab: { student: 2, parent: 1 } }),
      item('/a', { tab: { student: 1 } }),
      item('/x'),
      item('/d', { tab: { student: 4 } }),
      item('/c', { tab: { student: 3 } }),
    ];
    expect(tabsFor(items, 'student').map((i) => i.path)).toEqual(['/a', '/b', '/c', '/d']);
    expect(tabsFor(items, 'parent').map((i) => i.path)).toEqual(['/b']);
    expect(tabsFor(items, 'teacher')).toEqual([]);
  });

  it('groupMenu orders groups and puts ungrouped items under other', () => {
    const groups = groupMenu([item('/s', { group: 'settings' }), item('/x'), item('/f', { group: 'fees' })]);
    expect(groups.map((g) => [g.group, g.items.map((i) => i.path)])).toEqual([
      ['fees', ['/f']],
      ['settings', ['/s']],
      ['other', ['/x']],
    ]);
  });
});
