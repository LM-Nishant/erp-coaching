import { registerUsageCounter } from '../subscriptions/api';
import { teacherCount } from './hr.service';

/** Registers HR with provider modules; called from `onReady`. */
export function registerHrIntegrations(): void {
  // Billable teacher seats use the same rule as the `maxTeachers` plan-limit check.
  registerUsageCounter('teachers', () => teacherCount());
}
