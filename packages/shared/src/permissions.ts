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

/**
 * Sections of the role editor, in display order. Every permission declaration names one (backend
 * `PermissionDeclaration.area`).
 */
export const PERMISSION_AREAS = [
  'Institute',
  'People & admissions',
  'Academics',
  'Learning & exams',
  'Finance',
  'HR & payroll',
  'Communication',
  'Reports & files',
  'My account',
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number];

/**
 * Who may hold a permission: `any` role, only the Institute Admin system role (`admin-only`), or
 * the Student/Parent personas (`self-service`). Custom roles hold `any` permissions only.
 */
export type PermissionAccess = 'any' | 'admin-only' | 'self-service';

/** One entry of `GET /api/permissions`, in role-editor order (area, then module declaration order). */
export interface PermissionCatalogEntry {
  key: PermissionKey;
  module: string;
  action: PermissionAction;
  area: PermissionArea;
  /** Module label, e.g. "Fees & payments". */
  moduleLabel: string;
  /** Short name, e.g. "Approve fee changes". */
  label: string;
  /** One plain-language line, e.g. "Approve refunds, discounts and offline receipts". */
  description: string;
  access: PermissionAccess;
}

/** `GET /api/roles` item. System roles (`isSystem`) are shared templates and read-only. */
export interface RoleDto {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionKey[];
  /** Members of this institute holding the role (that the caller can see). */
  memberCount: number;
}

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: PermissionKey[];
}
