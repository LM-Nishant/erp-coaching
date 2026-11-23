import { QueryTypes } from 'sequelize';
import { SETUP_STEPS, type SetupStatusDto, type SetupStepKey } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { getPlanLimits } from '../subscriptions/api';

/** Plan module a step needs; steps without one always apply. */
const STEP_MODULE: Partial<Record<SetupStepKey, string>> = {
  course: 'academics',
  batch: 'academics',
  feeStructure: 'fees',
  paymentGateway: 'fees',
  student: 'students',
  parents: 'students',
};

/** One count per step, scoped to the institute (`:id`). */
const STEP_COUNT: Record<SetupStepKey, string> = {
  profile: `SELECT (logo_file_id IS NOT NULL) + (COALESCE(address, '') <> '') + (contact_phone IS NOT NULL)
              FROM institutes WHERE id = :id`,
  course: 'SELECT COUNT(*) FROM courses WHERE institute_id = :id AND is_template = 0',
  batch: 'SELECT COUNT(*) FROM batches WHERE institute_id = :id',
  feeStructure: 'SELECT COUNT(*) FROM fee_structures WHERE institute_id = :id',
  teacher: `SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.institute_id = :id AND r.slug = 'teacher'`,
  student: 'SELECT COUNT(*) FROM students WHERE institute_id = :id',
  paymentGateway: 'SELECT COUNT(*) FROM payment_gateway_configs WHERE institute_id = :id AND enabled = 1',
  parents: 'SELECT COUNT(*) FROM student_guardians WHERE institute_id = :id',
};

async function enabledModules(instituteId: number): Promise<string[] | null> {
  try {
    return (await getPlanLimits(instituteId)).enabledModules;
  } catch {
    return null;
  }
}

/** The new-institute checklist: what is set up so far, limited to the modules the plan includes. */
export async function setupStatus(instituteId: number): Promise<SetupStatusDto> {
  const modules = await enabledModules(instituteId);
  const keys = SETUP_STEPS.filter((k) => {
    const m = STEP_MODULE[k];
    return !m || !modules || modules.includes(m);
  });
  const sequelize = getSequelize();
  const steps = await Promise.all(
    keys.map(async (key) => {
      const rows = await sequelize.query<Record<string, unknown>>(STEP_COUNT[key], {
        replacements: { id: instituteId },
        type: QueryTypes.SELECT,
      });
      const count = Number(Object.values(rows[0] ?? {})[0] ?? 0);
      // A profile counts as done once a logo, address or phone is saved.
      return { key, count, done: count > 0 };
    }),
  );
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
