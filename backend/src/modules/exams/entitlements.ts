import { Batch } from '../academics/api';
import type { Exam } from './models';

export interface ExamEntitlementQuery {
  instituteId: number;
  /** Login user id of the student. */
  studentUserId: number;
  examId: number;
  /** Course the exam belongs to (its own course, else its batch's course); null = no course. */
  courseId: number | null;
  batchId: number | null;
}

/**
 * Extension point for the module that sells courses (fees): may a student start an attempt of a
 * (paid) exam? Register from the provider's `integrations.ts` in `onReady`:
 *
 *   import { setExamEntitlementProvider } from '../exams/api';
 *   setExamEntitlementProvider(async (q) => ...paid up for q.courseId?);
 *
 * Default (no provider): allowed — batch eligibility is still checked by exams itself.
 */
export type ExamEntitlementProvider = (q: ExamEntitlementQuery) => Promise<boolean>;

let provider: ExamEntitlementProvider | null = null;

export function setExamEntitlementProvider(p: ExamEntitlementProvider | null): void {
  provider = p;
}

export async function canStartExam(exam: Exam, studentUserId: number): Promise<boolean> {
  if (!provider) return true;
  let courseId = exam.courseId;
  if (!courseId && exam.batchId)
    courseId =
      (
        await Batch.findOne({
          where: { instituteId: exam.instituteId, id: exam.batchId },
          attributes: ['courseId'],
        })
      )?.courseId ?? null;
  return provider({
    instituteId: exam.instituteId,
    studentUserId,
    examId: exam.id,
    courseId,
    batchId: exam.batchId,
  });
}
