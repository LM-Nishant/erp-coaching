import { Op } from 'sequelize';
import { registerUsageCounter } from '../subscriptions/api';
import { registerBranchClosureGuard } from '../branches/api';
import { requireTenantContext } from '../../shared/context';
import { Student } from './models';
import { activeStudentCount } from './students.service';

/** Registers students with provider modules; called from `onReady`. */
export function registerStudentIntegrations(): void {
  // Billable student seats use the same rule as the `maxStudents` plan-limit check.
  registerUsageCounter('students', () => activeStudentCount());
  registerBranchClosureGuard('students', async (branchId) => {
    const { instituteId } = requireTenantContext();
    const count = await Student.count({
      where: { instituteId, branchId, status: { [Op.in]: ['active', 'suspended'] } },
    });
    return count ? `${count} active student(s) must be transferred to another branch first` : null;
  });
}
