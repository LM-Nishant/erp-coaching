import { SYSTEM_ROLES } from '@erp/shared';

/**
 * Who the signed-in user is for the app shell: picks the home page, the bottom tabs and which menu items
 * apply. One per session; derived from the roles of the selected institute (see `personaOf`).
 *
 * - `student`, `parent`, `teacher`: those system roles.
 * - `staff`: institute admin, branch admin, accountant and any custom role (front desk, counsellor…).
 * - `learner`: signed in without an institute (marketplace learners and independent instructors).
 * - `platform`: the super admin, when not impersonating.
 */
export const PERSONAS = ['student', 'parent', 'teacher', 'staff', 'learner', 'platform'] as const;
export type Persona = (typeof PERSONAS)[number];

const STAFF_ROLES: readonly string[] = [
  SYSTEM_ROLES.INSTITUTE_ADMIN,
  SYSTEM_ROLES.BRANCH_ADMIN,
  SYSTEM_ROLES.ACCOUNTANT,
];
const PERSONA_ROLES: readonly string[] = [SYSTEM_ROLES.TEACHER, SYSTEM_ROLES.STUDENT, SYSTEM_ROLES.PARENT];

export interface PersonaInput {
  /** Super admin and not impersonating (`auth.isPlatformAdmin`). */
  isPlatformAdmin: boolean;
  /** An institute is selected. */
  hasInstitute: boolean;
  /** Role slugs in the selected institute (`auth.me.roles`). */
  roles: readonly string[];
}

/**
 * The persona for a session. With several roles the most capable wins: staff, then teacher, then student,
 * then parent (a teacher who is also a parent works as a teacher). A role that is none of the system
 * persona roles is a custom staff role.
 */
export function personaOf({ isPlatformAdmin, hasInstitute, roles }: PersonaInput): Persona {
  if (isPlatformAdmin) return 'platform';
  if (!hasInstitute) return 'learner';
  if (roles.some((r) => STAFF_ROLES.includes(r) || !PERSONA_ROLES.includes(r))) return 'staff';
  if (roles.includes(SYSTEM_ROLES.TEACHER)) return 'teacher';
  if (roles.includes(SYSTEM_ROLES.STUDENT)) return 'student';
  if (roles.includes(SYSTEM_ROLES.PARENT)) return 'parent';
  return 'staff';
}

/**
 * Sections of the grouped "More" menu, in display order. Every menu item should name one (`MenuItem.group`);
 * items without a group go to `other`.
 */
export const MENU_GROUPS = [
  'home',
  'learning',
  'classes',
  'tests',
  'people',
  'fees',
  'messages',
  'hr',
  'reports',
  'website',
  'marketplace',
  'settings',
  'platform',
  'other',
] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

/** Bottom-tab bar size on phones: at most this many tabs, the last one being "More". */
export const MAX_TABS = 5;
