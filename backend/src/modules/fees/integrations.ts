import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { onAdmissionCompleted } from '../admissions/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { generateForAdmission } from './accounts.service';

/** Registers fees with provider modules; called from `onReady`. */
export function registerFeesIntegrations(): void {
  // A completed admission gets its fee account from the best matching active structure
  // (batch → course+branch → course). `sourceRef = admission:<id>` makes retries no-ops.
  onAdmissionCompleted('fees.account', async (e) => {
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'fees'))) return;
    const account = await generateForAdmission(e);
    if (!account) logger.info({ applicationId: e.applicationId }, 'No fee structure matched the admission');
  });
}
