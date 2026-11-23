import { describe, expect, it } from 'vitest';
import { homeOutline } from 'ionicons/icons';
import { appModules, tabsFor, type MenuItem } from './modules';
import { activeItem, searchMenu } from './navigation';
import { MENU_GROUPS, type Persona } from './persona';
import { i18n } from '@/i18n';

const allItems = appModules.flatMap((m) => m.menu ?? []);
const item = (title: string, path: string, group?: MenuItem['group']): MenuItem => ({
  title,
  path,
  group,
  icon: homeOutline,
});

describe('module menus', () => {
  it('put every item in a known group with a translated title', () => {
    const { te } = i18n.global;
    for (const i of allItems) {
      expect(MENU_GROUPS, i.path).toContain(i.group);
      expect(i.titleKey && te(i.titleKey, 'en'), `${i.path} titleKey`).toBeTruthy();
      if (i.tabTitleKey) expect(te(i.tabTitleKey, 'en'), `${i.path} tabTitleKey`).toBe(true);
    }
  });

  it('give each persona the tabs from the navigation design', () => {
    const paths = (p: Persona) => tabsFor(allItems, p).map((i) => i.path);
    expect(paths('student')).toEqual(['/home', '/live-classes', '/lms', '/my-exams']);
    expect(paths('parent')).toEqual(['/parent-home', '/attendance/my', '/my-fees', '/exam-results']);
    expect(paths('teacher')).toEqual(['/home', '/my-timetable', '/lms/homework', '/students']);
    expect(paths('staff')).toEqual(['/home', '/students', '/fees', '/communication']);
    expect(paths('learner')).toEqual(['/market', '/market/learning', '/market/wishlist', '/market/cart']);
    expect(paths('platform')[0]).toBe('/home');
    expect(paths('platform')).toHaveLength(4);
  });

  it('never give one persona two tabs at the same position', () => {
    for (const p of ['student', 'parent', 'teacher', 'staff', 'learner', 'platform'] as Persona[]) {
      const positions = allItems.filter((i) => i.tab?.[p] !== undefined).map((i) => i.tab![p]);
      expect(new Set(positions).size, p).toBe(positions.length);
    }
  });
});

describe('searchMenu', () => {
  const items = [
    item('Fee collection', '/fees', 'fees'),
    item('My fees', '/my-fees', 'fees'),
    item('Students', '/students', 'people'),
  ];
  const hindi: Record<string, string> = { '/fees': 'फीस वसूली', '/my-fees': 'मेरी फीस', '/students': 'छात्र' };

  it('matches every word, ignoring case, in menu order', () => {
    expect(searchMenu(items, 'FEE', (i) => i.title).map((i) => i.path)).toEqual(['/fees', '/my-fees']);
    expect(searchMenu(items, 'my fee', (i) => i.title).map((i) => i.path)).toEqual(['/my-fees']);
    expect(searchMenu(items, '  ', (i) => i.title)).toEqual([]);
  });

  it('finds items by their translated label, English title or group', () => {
    const label = (i: MenuItem) => hindi[i.path];
    expect(searchMenu(items, 'छात्र', label).map((i) => i.path)).toEqual(['/students']);
    expect(searchMenu(items, 'students', label).map((i) => i.path)).toEqual(['/students']);
    expect(searchMenu(items, 'people', label, (i) => i.group ?? '').map((i) => i.path)).toEqual([
      '/students',
    ]);
  });
});

describe('activeItem', () => {
  const items = [item('Home', '/home'), item('LMS', '/lms'), item('Homework', '/lms/homework')];

  it('picks the deepest item the page is in', () => {
    expect(activeItem(items, '/lms/homework/12')?.path).toBe('/lms/homework');
    expect(activeItem(items, '/lms/courses/3')?.path).toBe('/lms');
    expect(activeItem(items, '/home')?.path).toBe('/home');
  });

  it('does not match a path that only shares a prefix', () => {
    expect(activeItem(items, '/lmsx')).toBeUndefined();
    expect(activeItem(items, '/students')).toBeUndefined();
  });
});
