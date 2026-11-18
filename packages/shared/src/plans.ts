export interface PlanLimits {
  maxStudents: number | null;
  maxBranches: number | null;
  maxTeachers: number | null;
  storageMb: number | null;
  /** Monthly AI token allowance; null = unlimited, 0 = disabled. */
  aiTokensMonthly: number | null;
  /** Module ids the plan unlocks (`PLAN_MODULE_KEYS`); null = all modules. */
  enabledModules: string[] | null;
}

/**
 * Every module key a plan can enable (`requireModule`, `isModuleEnabled`, app menu `planModule`,
 * report `planModule`, module add-ons). When adding a key, also add a data migration that appends it
 * to existing plans/overrides with an explicit `enabledModules` list (see the subscriptions
 * `add-plan-module-keys` migration), or list it as intentionally excluded in its guard test.
 */
export const PLAN_MODULE_KEYS = [
  'academics',
  'admissions',
  'ai',
  'appointments',
  'attendance',
  'exams',
  'fees',
  'grievances',
  'hr',
  'live-classes',
  'lms',
  'parent-portal',
  'payroll',
  'question-bank',
  'reports',
  'students',
  'website',
] as const;
export type PlanModuleKey = (typeof PLAN_MODULE_KEYS)[number];

export type InstituteStatus = 'active' | 'inactive' | 'suspended';
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'expired' | 'cancelled';
