import type { PermissionArea, PermissionCatalogEntry, PermissionKey, RoleDto, RoleInput } from '@erp/shared';
import { PERMISSION_AREAS } from '@erp/shared';
import { api } from '@/core/api';

export interface RoleAssignment {
  roleId: number;
  slug?: string;
  name?: string;
  /** `null` = every branch of the institute. */
  branchId: number | null;
}

export interface MemberSummary {
  id: number;
  name: string;
  mobile: string;
  email: string | null;
  status: string;
  roles: RoleAssignment[];
}

export interface MemberDetail extends MemberSummary {
  branchIds: number[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewMember {
  name: string;
  mobile: string;
  email?: string;
  password?: string;
  roles: { roleId: number; branchId: number | null }[];
  branchIds: number[];
}

export const rolesApi = {
  catalog: () => api.get<PermissionCatalogEntry[]>('/permissions'),
  list: () => api.get<RoleDto[]>('/roles'),
  create: (input: RoleInput) => api.post<RoleDto>('/roles', input),
  update: (id: number, input: RoleInput) => api.put<RoleDto>(`/roles/${id}`, input),
  remove: (id: number) => api.delete(`/roles/${id}`),
  staff: (search?: string, page = 1) =>
    api.get<Page<MemberSummary>>('/users', {
      kind: 'staff',
      search: search || undefined,
      page,
      pageSize: 50,
    }),
  member: (id: number) => api.get<MemberDetail>(`/users/${id}`),
  setRoles: (
    id: number,
    body: { roles: { roleId: number; branchId: number | null }[]; branchIds: number[] },
  ) => api.put(`/users/${id}/roles`, body),
  addMember: (body: NewMember) => api.post<MemberSummary>('/users', body),
};

/** Student and Parent are personas given by admissions and guardian links, not staff roles. */
export const PERSONA_ROLES: readonly string[] = ['student', 'parent'];

export interface PermissionSection {
  /** Uppercase heading in the role editor. */
  title: string;
  /** Explains why a locked section's permissions cannot be ticked. */
  note?: string;
  locked: boolean;
  permissions: PermissionCatalogEntry[];
}

export const ADMIN_ONLY_NOTE = 'Only the Institute Admin role holds these; other roles cannot.';
export const SELF_SERVICE_NOTE =
  'Students and parents get these with their own login; staff roles cannot hold them.';

/**
 * Role editor sections: one per area (catalog order) with the permissions a custom role may hold, then the
 * Institute Admin only and student/parent self-service permissions, shown locked.
 */
export function permissionSections(catalog: readonly PermissionCatalogEntry[]): PermissionSection[] {
  const byArea = new Map<PermissionArea, PermissionCatalogEntry[]>();
  for (const p of catalog) {
    if (p.access !== 'any') continue;
    byArea.set(p.area, [...(byArea.get(p.area) ?? []), p]);
  }
  const sections: PermissionSection[] = PERMISSION_AREAS.filter((a) => byArea.has(a)).map((area) => ({
    title: area,
    locked: false,
    permissions: byArea.get(area)!,
  }));
  const adminOnly = catalog.filter((p) => p.access === 'admin-only');
  if (adminOnly.length)
    sections.push({
      title: 'Institute Admin only',
      note: ADMIN_ONLY_NOTE,
      locked: true,
      permissions: adminOnly,
    });
  const selfService = catalog.filter((p) => p.access === 'self-service');
  if (selfService.length)
    sections.push({
      title: 'Students & parents',
      note: SELF_SERVICE_NOTE,
      locked: true,
      permissions: selfService,
    });
  return sections;
}

/** Keys a custom role may hold. */
export function grantableKeys(catalog: readonly PermissionCatalogEntry[]): Set<string> {
  return new Set(catalog.filter((p) => p.access === 'any').map((p) => p.key));
}

/**
 * Splits a role's permissions into those a custom role may keep and those it may not (an older custom role may
 * hold permissions that are now Institute Admin only); saving drops the latter.
 */
export function splitGrantable(permissions: readonly string[], catalog: readonly PermissionCatalogEntry[]) {
  const ok = grantableKeys(catalog);
  return {
    kept: permissions.filter((k) => ok.has(k)) as PermissionKey[],
    dropped: permissions.filter((k) => !ok.has(k)) as PermissionKey[],
  };
}

/** Ticked by default on a new role: every staff member's own account (inbox, leave, payslips). */
export function defaultPermissions(catalog: readonly PermissionCatalogEntry[]): PermissionKey[] {
  return catalog.filter((p) => p.access === 'any' && p.area === 'My account').map((p) => p.key);
}

export function togglePermission(selected: readonly PermissionKey[], key: PermissionKey, on: boolean) {
  const rest = selected.filter((k) => k !== key);
  return on ? [...rest, key] : rest;
}

/** Name for a role copied from another, unique among `existing` names (case-insensitive). */
export function copyName(name: string, existing: readonly string[]) {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (copy)` : `${name} (copy ${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Body for `PUT /users/:id/roles`, which replaces every assignment and branch membership: keeps the member's
 * existing branch memberships and adds the branches of branch-scoped roles. Duplicate rows are merged.
 */
export function assignmentBody(
  rows: readonly { roleId: number | null; branchId: number | null }[],
  existingBranchIds: readonly number[],
) {
  const seen = new Set<string>();
  const roles: { roleId: number; branchId: number | null }[] = [];
  for (const r of rows) {
    if (r.roleId === null) continue;
    const id = `${r.roleId}:${r.branchId ?? '*'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    roles.push({ roleId: r.roleId, branchId: r.branchId });
  }
  const branchIds = [
    ...new Set([
      ...existingBranchIds,
      ...roles.map((r) => r.branchId).filter((b): b is number => b !== null),
    ]),
  ];
  return { roles, branchIds };
}

/** "Teacher (Main branch), Accountant" for a member's role list. */
export function describeAssignments(
  roles: readonly RoleAssignment[],
  branchName: (id: number) => string | undefined,
) {
  return roles
    .map((r) => {
      const name = r.name ?? 'Role';
      return r.branchId === null ? name : `${name} (${branchName(r.branchId) ?? 'one branch'})`;
    })
    .join(', ');
}
