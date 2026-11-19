/**
 * Extension point for device users who are staff rather than students. HR registers the provider
 * (hr/integrations.ts) so punches from the same biometric devices also feed staff attendance; when
 * no provider is registered (or HR is off for the institute) such PINs stay unmatched.
 */
export interface StaffPin {
  employeeId: number;
  pin: string;
  name: string;
}

export type StaffPunchOutcome = 'applied' | 'skipped' | 'unknown';

export interface StaffPunchProvider {
  /** Employees mapped to these device PINs, or every mapped employee when `pins` is omitted. */
  findByPins(pins?: string[]): Promise<StaffPin[]>;
  /** Whether the employee exists and is in the current user's branches. */
  isVisible(employeeId: number): Promise<boolean>;
  /** Maps an employee to a device PIN, or unmaps with null. Throws NotFound/Conflict. */
  setPin(employeeId: number, pin: string | null): Promise<void>;
  /**
   * Applies punches to staff attendance. `outcomes` has one entry per punch: `skipped` when the day
   * was recorded manually or as leave, `unknown` when the employee no longer exists.
   */
  ingest(punches: { employeeId: number; punchedAt: Date }[]): Promise<{ outcomes: StaffPunchOutcome[] }>;
}

let provider: StaffPunchProvider | null = null;

export function setStaffPunchProvider(p: StaffPunchProvider | null): void {
  provider = p;
}

export function getStaffPunchProvider(): StaffPunchProvider | null {
  return provider;
}
