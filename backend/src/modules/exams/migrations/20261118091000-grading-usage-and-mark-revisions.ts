import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const counter = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const cost = () => ({ type: DataTypes.DECIMAL(12, 6), allowNull: false, defaultValue: 0 });
const marks = () => ({ type: DataTypes.DECIMAL(8, 2), allowNull: true });

/** AI usage per grading call/job, and the append-only marks trail (AI output → teacher edits → published). */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('grading_jobs', 'provider', { type: DataTypes.STRING(30), allowNull: true });
  await qi.addColumn('grading_jobs', 'model', { type: DataTypes.STRING(150), allowNull: true });
  await qi.addColumn('grading_jobs', 'total_tokens', counter());
  await qi.addColumn('grading_jobs', 'image_count', counter());
  await qi.addColumn('grading_jobs', 'estimated_cost_usd', cost());

  await qi.addColumn('grading_results', 'provider', { type: DataTypes.STRING(30), allowNull: true });
  await qi.addColumn('grading_results', 'prompt_tokens', counter());
  await qi.addColumn('grading_results', 'completion_tokens', counter());
  await qi.addColumn('grading_results', 'image_count', counter());
  await qi.addColumn('grading_results', 'estimated_cost_usd', cost());
  await qi.addColumn('grading_results', 'latency_ms', { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
  await qi.addColumn('grading_results', 'ai_usage_id', fk('ai_usage', { allowNull: true }));

  await qi.createTable('exam_mark_revisions', {
    id: id(),
    ...tenantColumns(),
    exam_id: fk('exams'),
    attempt_id: fk('exam_attempts'),
    /** Null for attempt-level snapshots (published / unpublished). */
    answer_id: fk('exam_answers', { allowNull: true, onDelete: 'CASCADE' }),
    kind: { type: DataTypes.STRING(20), allowNull: false },
    source: { type: DataTypes.STRING(10), allowNull: false },
    marks: marks(),
    previous_marks: marks(),
    feedback: { type: DataTypes.TEXT, allowNull: true },
    grading_result_id: fk('grading_results', { allowNull: true }),
    correction_id: fk('exam_result_corrections', { allowNull: true }),
    actor_user_id: fk('users', { allowNull: true }),
    metadata: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('exam_mark_revisions', ['institute_id', 'answer_id']);
  await qi.addIndex('exam_mark_revisions', ['institute_id', 'attempt_id']);
  await qi.addIndex('exam_mark_revisions', ['institute_id', 'exam_id', 'kind']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.dropTable('exam_mark_revisions');
  for (const c of [
    'ai_usage_id',
    'latency_ms',
    'estimated_cost_usd',
    'image_count',
    'completion_tokens',
    'prompt_tokens',
    'provider',
  ])
    await qi.removeColumn('grading_results', c);
  for (const c of ['estimated_cost_usd', 'image_count', 'total_tokens', 'model', 'provider'])
    await qi.removeColumn('grading_jobs', c);
};
