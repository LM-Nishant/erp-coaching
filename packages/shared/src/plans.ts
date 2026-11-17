export interface PlanLimits {
  maxStudents: number | null;
  maxBranches: number | null;
  maxTeachers: number | null;
  storageMb: number | null;
  /** Monthly AI token allowance; null = unlimited, 0 = disabled. */
  aiTokensMonthly: number | null;
  /** Module ids the plan unlocks; null = all modules. */
  enabledModules: string[] | null;
}

export type InstituteStatus = 'active' | 'inactive' | 'suspended';
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'expired' | 'cancelled';
