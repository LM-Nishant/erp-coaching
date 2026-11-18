import { logger } from '../../infrastructure/logger';
import { requireTenantContext } from '../../shared/context';
import { onAdmissionCompleted } from '../admissions/api';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { generateForAdmission } from './accounts.service';
import { registerFeesParentPortal } from './parent-portal';
import { setExamEntitlementProvider } from '../exams/api';
import { setLiveEntitlementProvider } from '../live-classes/api';
import { resolveCourseEntitlement, setCourseEntitlementProvider } from '../lms/api';
import { setCheckoutHandoff, setCoursePriceResolver } from '../website/api';
import { activeCourseEntitlement, entitledCourseIds } from './entitlements';
import { courseCheckoutUrl, coursePrices, feesGatesCourse } from './course-sales';

/** Registers fees with provider modules; called from `onReady`. */
export function registerFeesIntegrations(): void {
  registerFeesParentPortal();
  registerCourseSalesIntegrations();
  // A completed admission gets its fee account from the best matching active structure
  // (batch → course+branch → course). `sourceRef = admission:<id>` makes retries no-ops.
  // Admissions completed by an online course purchase are already billed (`feeAccountId`).
  onAdmissionCompleted('fees.account', async (e) => {
    if (e.feeAccountId) return;
    const { instituteId } = requireTenantContext();
    if (!(await isModuleEnabled(instituteId, 'fees'))) return;
    const account = await generateForAdmission(e);
    if (!account) logger.info({ applicationId: e.applicationId }, 'No fee structure matched the admission');
  });
}

/**
 * Paid courses: when fees is enabled and a course has an active fee structure, access to its LMS
 * content, exams and live classes follows the fee entitlement (first N instalments paid) instead of
 * plain batch enrolment. Courses without a price keep the consumers' defaults.
 */
function registerCourseSalesIntegrations(): void {
  setCourseEntitlementProvider({
    async hasCourseEntitlement(q, batchDefault) {
      if (!(await feesGatesCourse(q.instituteId, q.courseId))) return batchDefault(q);
      const e = await activeCourseEntitlement(q.instituteId, q.studentUserId, q.courseId);
      return e
        ? { entitled: true, since: e.grantedAt, until: null, source: 'fees' }
        : { entitled: false, since: null, until: null, source: 'fees' };
    },
    async listEntitledCourseIds({ instituteId, studentUserId }) {
      if (!(await isModuleEnabled(instituteId, 'fees'))) return [];
      return entitledCourseIds(studentUserId, instituteId);
    },
  });
  // Exams and live classes already require batch membership; for paid courses the student must
  // also be entitled (fee entitlement or an LMS manual grant).
  const paidAccess = async (q: { instituteId: number; studentUserId: number; courseId: number | null }) => {
    if (!q.courseId || !(await feesGatesCourse(q.instituteId, q.courseId))) return true;
    const e = await resolveCourseEntitlement({
      instituteId: q.instituteId,
      studentUserId: q.studentUserId,
      courseId: q.courseId,
    });
    return e.entitled;
  };
  setExamEntitlementProvider(paidAccess);
  setLiveEntitlementProvider(paidAccess);

  setCoursePriceResolver(coursePrices);
  setCheckoutHandoff((input) => courseCheckoutUrl(input));
}
