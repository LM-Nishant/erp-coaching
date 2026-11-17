import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { onClassSessionCompleted } from '../academics/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { Employee } from '../hr/models';
import { recordWorkUnits } from './payroll.service';

/** Registers payroll with provider modules; called from `onReady`. */
export function registerPayrollIntegrations(): void {
  // Each completed class becomes one `lecture` work unit for the teacher who took it (the
  // substitute, if any). `externalRef` makes re-completion/retries update instead of duplicate.
  onClassSessionCompleted('payroll.work-units', async (e) => {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'payroll'))) return;
    const employee = await Employee.findOne({
      where: { instituteId, userId: e.teacherUserId },
      attributes: ['id'],
    });
    if (!employee) return; // teacher not on the HR roster → nothing to pay through payroll
    const result = await recordWorkUnits(
      [
        {
          employeeId: employee.id,
          date: e.date,
          unitType: 'lecture',
          quantity: 1,
          description: 'Class taken',
          referenceType: 'class_session',
          referenceId: String(e.classSessionId),
          externalRef: `academics:class-session:${e.classSessionId}`,
        },
      ],
      'api',
    );
    if (result.rejected.length)
      logger.info(
        { classSessionId: e.classSessionId, reason: result.rejected[0].reason },
        'Lecture work unit not recorded',
      );
  });
}
