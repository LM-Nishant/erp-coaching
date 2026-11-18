import { registerUsageCounter } from '../subscriptions/api';
import { activeStudentCount } from './students.service';

/** Registers students with provider modules; called from `onReady`. */
export function registerStudentIntegrations(): void {
  // Billable student seats use the same rule as the `maxStudents` plan-limit check.
  registerUsageCounter('students', () => activeStudentCount());
}
