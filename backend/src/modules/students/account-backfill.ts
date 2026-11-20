/**
 * Repairs students admitted before every student got a login account of their own. A sibling admitted on a
 * mobile another student already used got none (`students.user_id` null), so admitting them could not enrol
 * them in the batch (`batchEnrolment: 'no_login'` in their history) and a course they bought waited for a
 * batch (`fee_course_enrolments.reason = 'no_login'`). Run once after upgrading, from the database CLI
 * (`students:backfill-accounts [--dry-run] [--institute=<id>[,<id>…]]`). For each such student it:
 * 1. creates or links their account, exactly as admitting them would now (`ensureStudentUser`);
 * 2. enrols them in the batch their admission named, under the usual rules (open, same course and
 *    branch, a free seat);
 * 3. retries their course purchases that were waiting for a login (`reconcileCourseEnrolment`);
 * 4. fills the account into the rows that copy it next to the student id (fees, appointments).
 * Running it again only picks up what is still missing. What it cannot do is listed in `problems`.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import { COURSE_BATCH_ISSUE_LABELS } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { runWithContext } from '../../shared/context';
import {
  Batch,
  BatchStudent,
  batchAvailability,
  batchUnavailableError,
  enrollStudentsInBatch,
} from '../academics/api';
import { reconcileCourseEnrolment } from '../fees/api';
import { User, accountsOnMobile } from '../users/user.model';
import { Student } from './models';
import { ensureStudentUser, recordHistory } from './students.service';

/** Tables that keep the student's login next to `student_id`; their readers also match on the student id. */
const STUDENT_USER_COPIES = [
  'fee_accounts',
  'fee_entitlements',
  'fee_course_enrolments',
  'appointments',
] as const;

/** Students who keep their seat: the statuses counted against the plan's student limit. */
const ENROLLABLE = ['active', 'suspended'];

export interface AccountBackfillInstitute {
  instituteId: number;
  /** New accounts owning the student's mobile (nobody had an account on it). */
  accountsOwningMobile: number;
  /** New accounts sharing a mobile that another account owns (siblings). */
  accountsSharingMobile: number;
  /** Existing accounts on the mobile linked to the student (e.g. their own account from another institute). */
  accountsLinked: number;
  /** Batch enrolments made for admissions that could not enrol the student. */
  enrolledInBatch: number;
  /** Those admissions whose student is or was already in the batch or another batch of the course. */
  alreadyInBatch: number;
  /** Course purchases that waited for a login and now have a batch (dry run: the waiting ones it would retry). */
  coursePurchases: number;
}

export interface AccountBackfillProblem {
  instituteId: number;
  studentId: number;
  admissionNumber: string;
  student: string;
  item: string;
  reason: string;
}

export interface AccountBackfillReport {
  dryRun: boolean;
  institutes: AccountBackfillInstitute[];
  /** Rows given the student's login per table (dry run: rows still without one). */
  copies: Record<string, number>;
  problems: AccountBackfillProblem[];
}

class DryRunRollback extends Error {}

/** Runs `fn` in a transaction that a dry run rolls back. */
async function unitOfWork(dryRun: boolean, fn: (transaction: Transaction) => Promise<void>): Promise<void> {
  try {
    await getSequelize().transaction(async (transaction) => {
      await fn(transaction);
      if (dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const emptyCounts = (instituteId: number): AccountBackfillInstitute => ({
  instituteId,
  accountsOwningMobile: 0,
  accountsSharingMobile: 0,
  accountsLinked: 0,
  enrolledInBatch: 0,
  alreadyInBatch: 0,
  coursePurchases: 0,
});

function addCounts(to: AccountBackfillInstitute, delta: AccountBackfillInstitute) {
  for (const key of Object.keys(delta) as (keyof AccountBackfillInstitute)[])
    if (key !== 'instituteId') to[key] += delta[key];
}

const problemOf = (
  s: Pick<Student, 'instituteId' | 'id' | 'admissionNumber' | 'name'>,
  item: string,
  reason: string,
): AccountBackfillProblem => ({
  instituteId: s.instituteId,
  studentId: s.id,
  admissionNumber: s.admissionNumber,
  student: s.name,
  item,
  reason,
});

interface RecordedBatch {
  batchId: number;
  courseId: number | null;
}

/** `student_history.details` (a JSON column; some drivers hand it back as text). */
function recordedBatch(details: unknown): RecordedBatch | null {
  let d: { batchId?: unknown; courseId?: unknown } | null;
  try {
    d = (typeof details === 'string' ? JSON.parse(details) : details) as typeof d;
  } catch {
    return null;
  }
  const batchId = Number(d?.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return null;
  const courseId = Number(d?.courseId);
  return { batchId, courseId: Number.isInteger(courseId) && courseId > 0 ? courseId : null };
}

/**
 * Gives every student without a login account one and finishes what admitting them left undone (see the
 * file comment). `dryRun` makes every change and rolls it back, one student at a time, so when several
 * students compete for the last seats of a batch it can report more enrolments than the real run.
 * `instituteIds` limits the run to those institutes (default: all).
 */
export async function backfillStudentAccounts(
  opts: { dryRun?: boolean; instituteIds?: number[] } = {},
): Promise<AccountBackfillReport> {
  const dryRun = !!opts.dryRun;
  const sequelize = getSequelize();
  const only = opts.instituteIds;
  const report: AccountBackfillReport = { dryRun, institutes: [], copies: {}, problems: [] };
  if (only && !only.length) return report;
  const scope = (column: string) => (only ? `AND ${column} IN (:only)` : '');
  const select = <T extends object>(sql: string) =>
    sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements: { only: only ?? [] } });

  const withoutAccount = await select<{ institute_id: number; id: number }>(
    `SELECT institute_id, id FROM students WHERE user_id IS NULL ${scope('institute_id')}
     ORDER BY institute_id, id`,
  );
  // Admissions that named a batch but could not enrol the student for want of a login.
  const unenrolled = await select<{ institute_id: number; student_id: number; details: unknown }>(
    `SELECT institute_id, student_id, details FROM student_history
     WHERE event_type = 'admitted_for_course'
       AND JSON_UNQUOTE(JSON_EXTRACT(details, '$.batchEnrolment')) = 'no_login' ${scope('institute_id')}
     ORDER BY id`,
  );
  const waitingPurchases = await select<{ institute_id: number; account_id: number; student_id: number }>(
    `SELECT institute_id, account_id, student_id FROM fee_course_enrolments
     WHERE status = 'awaiting_batch' AND reason = 'no_login' ${scope('institute_id')}
     ORDER BY id`,
  );

  const instituteIds = [
    ...new Set([...withoutAccount, ...unenrolled, ...waitingPurchases].map((r) => Number(r.institute_id))),
  ].sort((a, b) => a - b);

  for (const instituteId of instituteIds) {
    const counts = emptyCounts(instituteId);
    const batchesByStudent = new Map<number, RecordedBatch[]>();
    for (const id of withoutAccount.filter((r) => Number(r.institute_id) === instituteId))
      batchesByStudent.set(Number(id.id), []);
    for (const h of unenrolled.filter((r) => Number(r.institute_id) === instituteId)) {
      const batch = recordedBatch(h.details);
      const list = batchesByStudent.get(Number(h.student_id)) ?? [];
      if (batch && !list.some((b) => b.batchId === batch.batchId)) list.push(batch);
      batchesByStudent.set(Number(h.student_id), list);
    }

    await runWithContext({ system: true, instituteId, allowedBranchIds: null }, async () => {
      for (const [studentId, batches] of [...batchesByStudent].sort((a, b) => a[0] - b[0])) {
        const student = await Student.findOne({ where: { instituteId, id: studentId } });
        if (!student) continue; // deleted since
        // Kept only when the student's changes commit (or, in a dry run, complete).
        const delta = emptyCounts(instituteId);
        const problems: AccountBackfillProblem[] = [];
        try {
          await unitOfWork(dryRun, async (transaction) => {
            if (!student.userId) {
              const before = new Set(
                (await accountsOnMobile(student.mobile, { transaction })).map((u) => u.id),
              );
              const userId = await ensureStudentUser(student, transaction);
              if (before.has(userId)) delta.accountsLinked++;
              else if ((await User.findByPk(userId, { attributes: ['mobile'], transaction }))?.mobile)
                delta.accountsOwningMobile++;
              else delta.accountsSharingMobile++;
            }
            for (const recorded of batches) {
              try {
                // A savepoint: a failed enrolment keeps the account.
                await sequelize.transaction({ transaction }, (savepoint) =>
                  enrolInBatch(student, recorded, savepoint, delta, problems),
                );
              } catch (err) {
                problems.push(
                  problemOf(student, `batch #${recorded.batchId}`, `not enrolled: ${message(err)}`),
                );
              }
            }
          });
          addCounts(counts, delta);
          report.problems.push(...problems);
        } catch (err) {
          report.problems.push(problemOf(student, 'login account', `not created: ${message(err)}`));
        }
      }

      for (const p of waitingPurchases.filter((r) => Number(r.institute_id) === instituteId)) {
        if (dryRun) {
          counts.coursePurchases++;
          continue;
        }
        const student = await Student.findOne({ where: { instituteId, id: p.student_id } });
        if (!student) continue;
        const item = `course purchase (fee account #${p.account_id})`;
        try {
          const row = await reconcileCourseEnrolment(Number(p.account_id));
          if (row?.status === 'enrolled') counts.coursePurchases++;
          else if (row?.status === 'awaiting_batch')
            report.problems.push(
              problemOf(
                student,
                item,
                `still waiting for a batch: ${COURSE_BATCH_ISSUE_LABELS[row.reason ?? 'no_open_batch']}`,
              ),
            );
        } catch (err) {
          report.problems.push(problemOf(student, item, message(err)));
        }
      }
    });
    report.institutes.push(counts);
  }

  for (const table of STUDENT_USER_COPIES) {
    const join = `FROM ${table} t JOIN students s ON s.institute_id = t.institute_id AND s.id = t.student_id`;
    if (dryRun) {
      const [row] = await select<{ n: number }>(
        `SELECT COUNT(*) AS n ${join} WHERE t.student_user_id IS NULL ${scope('t.institute_id')}`,
      );
      report.copies[table] = Number(row?.n ?? 0);
    } else {
      const [, affected] = (await sequelize.query(
        `UPDATE ${table} t JOIN students s ON s.institute_id = t.institute_id AND s.id = t.student_id
         SET t.student_user_id = s.user_id
         WHERE t.student_user_id IS NULL AND s.user_id IS NOT NULL ${scope('t.institute_id')}`,
        { type: QueryTypes.UPDATE, replacements: { only: only ?? [] } },
      )) as [unknown, number];
      report.copies[table] = Number(affected ?? 0);
    }
  }
  return report;
}

/**
 * Enrols a newly linked student in the batch their admission named, under the rules admitting them applies
 * now. A student who is or was in any batch of the course (any status) is left alone, so a run never
 * undoes an admin's change or puts the student in a second batch of the course.
 */
async function enrolInBatch(
  student: Student,
  recorded: RecordedBatch,
  transaction: Transaction,
  counts: AccountBackfillInstitute,
  problems: AccountBackfillProblem[],
) {
  const { instituteId } = student;
  const userId = student.userId!;
  const batch = await Batch.findOne({
    where: { instituteId, id: recorded.batchId },
    attributes: ['id', 'name', 'courseId'],
    transaction,
  });
  const item = batch ? `batch "${batch.name}" (#${batch.id})` : `batch #${recorded.batchId}`;
  const courseId = recorded.courseId ?? batch?.courseId ?? null;
  // Any batch of the course counts: an admin may have placed the student in another one since.
  const courseBatchIds = courseId
    ? (await Batch.findAll({ where: { instituteId, courseId }, attributes: ['id'], transaction })).map(
        (b) => b.id,
      )
    : [];
  if (
    await BatchStudent.findOne({
      where: { instituteId, studentUserId: userId, batchId: [recorded.batchId, ...courseBatchIds] },
      attributes: ['id'],
      transaction,
    })
  ) {
    counts.alreadyInBatch++;
    return;
  }
  if (!ENROLLABLE.includes(student.status)) {
    problems.push(problemOf(student, item, `not enrolled: the student is ${student.status}`));
    return;
  }
  const { reason } = batch
    ? await batchAvailability(batch.id, {
        courseId: courseId ?? batch.courseId,
        branchId: student.branchId,
        studentUserId: userId,
        transaction,
      })
    : { reason: 'not_found' as const };
  if (reason) {
    problems.push(problemOf(student, item, `not enrolled: ${batchUnavailableError(reason).message}`));
    return;
  }
  await enrollStudentsInBatch(recorded.batchId, [userId], { branchId: student.branchId, transaction });
  await recordHistory(
    student.id,
    'enrolled_in_batch',
    {
      to: `batch:${recorded.batchId}`,
      details: {
        batchId: recorded.batchId,
        courseId: courseId ?? batch!.courseId,
        source: 'account_backfill',
      },
    },
    transaction,
  );
  counts.enrolledInBatch++;
}
