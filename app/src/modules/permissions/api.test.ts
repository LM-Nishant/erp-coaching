import { describe, expect, it } from 'vitest';
import type { PermissionCatalogEntry, PermissionKey } from '@erp/shared';
import {
  ADMIN_ONLY_NOTE,
  assignmentBody,
  copyName,
  defaultPermissions,
  describeAssignments,
  permissionSections,
  splitGrantable,
  togglePermission,
} from './api';

const entry = (
  key: string,
  area: PermissionCatalogEntry['area'],
  access: PermissionCatalogEntry['access'] = 'any',
): PermissionCatalogEntry => {
  const [module, action] = key.split('.');
  return {
    key: key as PermissionKey,
    module,
    action: action as PermissionCatalogEntry['action'],
    area,
    moduleLabel: module,
    label: `Label ${key}`,
    description: `Does ${key}`,
    access,
  };
};

const catalog = [
  entry('branches.view', 'Institute'),
  entry('branches.create', 'Institute', 'admin-only'),
  entry('fees.view', 'Finance'),
  entry('students.view', 'People & admissions'),
  entry('fees.approve', 'Finance'),
  entry('student-portal.view', 'My account', 'self-service'),
  entry('hr-self-service.view', 'My account'),
  entry('roles.create', 'Institute', 'admin-only'),
];

describe('permissionSections', () => {
  it('groups grantable permissions by area in area order, then the locked ones', () => {
    const sections = permissionSections(catalog);
    expect(sections.map((s) => [s.title, s.locked])).toEqual([
      ['Institute', false],
      ['People & admissions', false],
      ['Finance', false],
      ['My account', false],
      ['Institute Admin only', true],
      ['Students & parents', true],
    ]);
    expect(sections[2].permissions.map((p) => p.key)).toEqual(['fees.view', 'fees.approve']);
    expect(sections[4].permissions.map((p) => p.key)).toEqual(['branches.create', 'roles.create']);
    expect(sections[4].note).toBe(ADMIN_ONLY_NOTE);
  });

  it('omits locked sections with nothing in them', () => {
    const sections = permissionSections(catalog.filter((p) => p.access === 'any'));
    expect(sections.every((s) => !s.locked)).toBe(true);
  });
});

describe('role permissions', () => {
  it('drops permissions a custom role cannot hold', () => {
    expect(
      splitGrantable(['fees.view', 'roles.create', 'student-portal.view', 'gone.view'], catalog),
    ).toEqual({
      kept: ['fees.view'],
      dropped: ['roles.create', 'student-portal.view', 'gone.view'],
    });
  });

  it('ticks staff self-service by default', () => {
    expect(defaultPermissions(catalog)).toEqual(['hr-self-service.view']);
  });

  it('toggles without duplicates', () => {
    const on = togglePermission(['fees.view'], 'fees.view', true);
    expect(on).toEqual(['fees.view']);
    expect(togglePermission(on, 'fees.approve', true)).toEqual(['fees.view', 'fees.approve']);
    expect(togglePermission(on, 'fees.view', false)).toEqual([]);
  });

  it('names copies uniquely', () => {
    expect(copyName('Teacher', ['Teacher'])).toBe('Teacher (copy)');
    expect(copyName('Teacher', ['Teacher', 'teacher (COPY)'])).toBe('Teacher (copy 2)');
  });
});

describe('assignmentBody', () => {
  it('keeps branch memberships, adds scoped branches and merges duplicates', () => {
    expect(
      assignmentBody(
        [
          { roleId: 4, branchId: null },
          { roleId: 9, branchId: 2 },
          { roleId: 9, branchId: 2 },
          { roleId: null, branchId: 3 },
          { roleId: 9, branchId: 5 },
        ],
        [1, 2],
      ),
    ).toEqual({
      roles: [
        { roleId: 4, branchId: null },
        { roleId: 9, branchId: 2 },
        { roleId: 9, branchId: 5 },
      ],
      branchIds: [1, 2, 5],
    });
  });

  it('describes a member’s roles with their branch', () => {
    const names: Record<number, string> = { 2: 'Baner' };
    expect(
      describeAssignments(
        [
          { roleId: 1, name: 'Teacher', branchId: 2 },
          { roleId: 2, name: 'Auditor', branchId: null },
          { roleId: 3, name: 'Desk', branchId: 7 },
        ],
        (id) => names[id],
      ),
    ).toBe('Teacher (Baner), Auditor, Desk (one branch)');
  });
});
