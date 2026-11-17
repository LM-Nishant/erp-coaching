/** Actions available on every module (spec §3.1). */
export const PERMISSION_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'export',
  'publish',
  'configure',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Permission keys are always `<module>.<action>`, e.g. `branches.create`. */
export type PermissionKey = `${string}.${PermissionAction}`;

export function permissionKey(module: string, action: PermissionAction): PermissionKey {
  return `${module}.${action}`;
}

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'super-admin',
  INSTITUTE_ADMIN: 'institute-admin',
  BRANCH_ADMIN: 'branch-admin',
  ACCOUNTANT: 'accountant',
  TEACHER: 'teacher',
  STUDENT: 'student',
  PARENT: 'parent',
} as const;

export type SystemRoleSlug = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
