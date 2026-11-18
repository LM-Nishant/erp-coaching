import type { Transaction } from 'sequelize';
import type { MarkRevisionDto, MarkRevisionKind, MarkRevisionSource, ResultCorrectionDto } from '@erp/shared';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { getContext } from '../../shared/context';
import { User } from '../users/user.model';
import { ExamMarkRevision, type ExamResultCorrection } from './models';

export const revisionRepo = new TenantRepository(ExamMarkRevision, { entity: 'Mark revision' });

export interface RevisionInput {
  examId: number;
  attemptId: number;
  answerId: number | null;
  kind: MarkRevisionKind;
  source: MarkRevisionSource;
  marks: number | null;
  previousMarks?: number | null;
  feedback?: string | null;
  gradingResultId?: number | null;
  correctionId?: number | null;
  /** Defaults to the current user (null for jobs). */
  actorUserId?: number | null;
  metadata?: Record<string, unknown> | null;
}

/** Appends to the marks trail. Rows are never updated or deleted. */
export async function recordRevisions(rows: RevisionInput[], opts: { transaction?: Transaction } = {}) {
  const actor = getContext().userId ?? null;
  for (const r of rows) {
    await revisionRepo.create(
      {
        examId: r.examId,
        attemptId: r.attemptId,
        answerId: r.answerId,
        kind: r.kind,
        source: r.source,
        marks: r.marks,
        previousMarks: r.previousMarks ?? null,
        feedback: r.feedback ?? null,
        gradingResultId: r.gradingResultId ?? null,
        correctionId: r.correctionId ?? null,
        actorUserId: r.actorUserId !== undefined ? r.actorUserId : actor,
        metadata: r.metadata ?? null,
      },
      opts,
    );
  }
}

export const recordRevision = (r: RevisionInput, opts: { transaction?: Transaction } = {}) =>
  recordRevisions([r], opts);

export function revisionDto(r: ExamMarkRevision): MarkRevisionDto {
  return {
    id: r.id,
    attemptId: r.attemptId,
    answerId: r.answerId,
    kind: r.kind,
    source: r.source,
    marks: r.marks,
    previousMarks: r.previousMarks,
    feedback: r.feedback,
    gradingResultId: r.gradingResultId,
    correctionId: r.correctionId,
    actorName: r.actor?.name ?? null,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  };
}

export const actorInclude = { model: User, as: 'actor', attributes: ['id', 'name'] };

export function correctionDto(c: ExamResultCorrection): ResultCorrectionDto {
  return {
    id: c.id,
    answerId: c.answerId,
    beforeMarks: c.beforeMarks,
    afterMarks: c.afterMarks,
    reason: c.reason,
    correctedByName: c.correctedBy?.name ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
