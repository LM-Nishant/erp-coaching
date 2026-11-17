import { Op } from 'sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { Job } from '../../infrastructure/jobs/job.model';
import { logger } from '../../infrastructure/logger';
import { requireTenantContext, runWithContext } from '../../shared/context';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { Student } from '../students/models';
import { FeeAccount, FeeInstalment } from './models';
import { applyLateFee } from './accounts.service';
import { getFeeSettings } from './settings.service';
import { releaseStaleCouponReservations } from './payments.service';
import { money, notifyStudent } from './notifications';
import { addDays, today } from './util';

export const FEES_SWEEP_JOB = 'fees.sweep';
export const FEES_INSTITUTE_SWEEP_JOB = 'fees.institute-sweep';
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Per-institute daily work: due-date reminders, overdue notices and late fees. Each step is
 * idempotent (`reminderSentAt`, `overdueNotifiedAt`, late-fee journal keys), so re-runs are safe.
 */
export async function runInstituteSweep(asOf = today()) {
  const { instituteId } = requireTenantContext();
  if (!(await isModuleEnabled(instituteId, 'fees'))) return { reminders: 0, overdue: 0, lateFees: 0 };
  const settings = await getFeeSettings();
  const open = await FeeInstalment.findAll({
    where: {
      instituteId,
      status: { [Op.in]: ['pending', 'partial'] },
      dueDate: { [Op.lte]: addDays(asOf, settings.reminderDaysBefore) },
    },
    include: [{ model: FeeAccount, as: 'account', where: { instituteId, status: 'active' }, required: true }],
    limit: 5000,
  });
  const studentIds = [...new Set(open.map((i) => i.account!.studentId))];
  const students = studentIds.length
    ? await Student.findAll({ where: { instituteId, id: { [Op.in]: studentIds } } })
    : [];
  const byId = new Map(students.map((s) => [s.id, s]));
  let reminders = 0;
  let overdue = 0;
  let lateFees = 0;
  for (const inst of open) {
    const student = byId.get(inst.account!.studentId);
    try {
      if (inst.dueDate < asOf) {
        if (settings.lateFee.type !== 'none' && (await applyLateFee(inst.id, asOf)) > 0) lateFees++;
        if (!inst.overdueNotifiedAt && student) {
          await inst.update({ overdueNotifiedAt: new Date() });
          await notifyStudent(
            'fees.overdue',
            student,
            { amount: money(inst.balance), dueDate: inst.dueDate },
            inst.account!.branchId,
          );
          overdue++;
        }
      } else if (!inst.reminderSentAt && student) {
        await inst.update({ reminderSentAt: new Date() });
        await notifyStudent(
          'fees.due',
          student,
          { amount: money(inst.balance), dueDate: inst.dueDate },
          inst.account!.branchId,
        );
        reminders++;
      }
    } catch (err) {
      logger.warn({ instituteId, instalmentId: inst.id, err }, 'Fee sweep item failed');
    }
  }
  try {
    await releaseStaleCouponReservations();
  } catch (err) {
    logger.warn({ instituteId, err }, 'Releasing stale coupon reservations failed');
  }
  return { reminders, overdue, lateFees };
}

/** Platform sweep: fans out to institutes with open instalments; re-enqueues itself. */
export async function runFeesSweep() {
  try {
    const rows = (await FeeInstalment.findAll({
      where: { status: { [Op.in]: ['pending', 'partial'] }, dueDate: { [Op.lte]: addDays(today(), 31) } },
      attributes: ['instituteId'],
      group: ['instituteId'],
      raw: true,
      tenantBypass: true, // system job across institutes; each institute then runs in its own context
    } as object)) as unknown as { instituteId: number }[];
    for (const { instituteId } of rows) {
      await runWithContext({ system: true, instituteId, allowedBranchIds: null }, async () => {
        try {
          await runInstituteSweep();
        } catch (err) {
          logger.warn({ instituteId, err }, 'Fees sweep failed for institute');
        }
      });
    }
  } finally {
    await scheduleFeesSweep();
  }
}

export async function scheduleFeesSweep() {
  const pending = await Job.findOne({
    where: { name: FEES_SWEEP_JOB, status: { [Op.in]: ['pending', 'running'] } },
  });
  if (pending && pending.status === 'pending') return;
  await enqueueJob(
    FEES_SWEEP_JOB,
    {},
    { instituteId: null, runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) },
  );
}
