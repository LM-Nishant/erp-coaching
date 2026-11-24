import { Forbidden } from '../../shared/errors';
import { requireTenantContext } from '../../shared/context';
import { setStaffPunchProvider } from '../attendance/api';
import { registerMeFeature } from '../authentication/api';
import { isModuleEnabled, registerUsageCounter } from '../subscriptions/api';
import {
  applyBiometricPunches,
  hasStaffProfile,
  employeeRepo,
  employeesByPins,
  setEmployeePin,
  teacherCount,
} from './hr.service';

const hrEnabled = () => isModuleEnabled(requireTenantContext().instituteId, 'hr');

/** Registers HR with provider modules; called from `onReady`. */
export function registerHrIntegrations(): void {
  // Billable teacher seats use the same rule as the `maxTeachers` plan-limit check.
  registerUsageCounter('teachers', () => teacherCount());

  // The app shows "My leave & attendance" and "My payslips" only to logins linked to an employee.
  registerMeFeature('staff-profile', async () => (await hrEnabled()) && hasStaffProfile());

  // Staff punches on the attendance module's biometric devices become staff attendance.
  setStaffPunchProvider({
    findByPins: async (pins) => ((await hrEnabled()) ? employeesByPins(pins) : []),
    isVisible: async (employeeId) =>
      (await hrEnabled()) && (await employeeRepo.count({ id: employeeId })) > 0,
    setPin: async (employeeId, pin) => {
      if (!(await hrEnabled())) throw Forbidden('HR is not enabled for this institute', 'MODULE_DISABLED');
      await setEmployeePin(employeeId, pin);
    },
    ingest: async (punches) =>
      (await hrEnabled())
        ? applyBiometricPunches(punches)
        : { outcomes: punches.map(() => 'unknown' as const) },
  });
}
