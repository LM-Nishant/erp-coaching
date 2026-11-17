import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const marks = (defaultValue: number | null = 0) => ({
  type: DataTypes.DECIMAL(8, 2),
  allowNull: defaultValue === null,
  ...(defaultValue === null ? {} : { defaultValue }),
});

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('prompt_versions', {
    id: id(),
    ...tenantColumns(),
    feature: { type: DataTypes.STRING(80), allowNull: false },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    system_prompt: { type: DataTypes.TEXT, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('prompt_versions', ['institute_id', 'feature', 'version'], { unique: true });

  await qi.createTable('exams', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    instructions: { type: DataTypes.TEXT, allowNull: true },
    batch_id: fk('batches', { allowNull: true }),
    course_id: fk('courses', { allowNull: true }),
    subject_id: fk('subjects', { allowNull: true }),
    start_at: { type: DataTypes.DATE, allowNull: false },
    end_at: { type: DataTypes.DATE, allowNull: false },
    duration_minutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'draft' },
    evaluation_mode: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'manual' },
    prompt_version_id: fk('prompt_versions', { allowNull: true }),
    shuffle_questions: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    shuffle_options: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    partial_marking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    default_marks: marks(1),
    default_negative_marks: marks(0),
    pass_marks: marks(null),
    results_published_at: { type: DataTypes.DATE, allowNull: true },
    results_published_by: fk('users', { allowNull: true }),
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('exams', ['institute_id', 'branch_id', 'start_at']);
  await qi.addIndex('exams', ['institute_id', 'batch_id']);
  await qi.addIndex('exams', ['institute_id', 'course_id']);

  await qi.createTable('exam_sections', {
    id: id(),
    ...tenantColumns(),
    exam_id: fk('exams'),
    title: { type: DataTypes.STRING(150), allowNull: false },
    instructions: { type: DataTypes.TEXT, allowNull: true },
    sort_order: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('exam_sections', ['institute_id', 'exam_id']);

  await qi.createTable('exam_questions', {
    id: id(),
    ...tenantColumns(),
    exam_id: fk('exams'),
    section_id: fk('exam_sections'),
    question_id: { ...fk('questions'), onDelete: 'RESTRICT' },
    sort_order: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    marks: marks(1),
    negative_marks: marks(0),
    partial_marking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** Frozen copy of the question (text, options, answer key) used for delivery and scoring. */
    snapshot: { type: DataTypes.JSON, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('exam_questions', ['institute_id', 'exam_id']);
  await qi.addIndex('exam_questions', ['exam_id', 'question_id'], { unique: true });

  await qi.createTable('exam_attempts', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    exam_id: fk('exams'),
    student_user_id: fk('users'),
    status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'in_progress' },
    started_at: { type: DataTypes.DATE, allowNull: false },
    deadline_at: { type: DataTypes.DATE, allowNull: false },
    submitted_at: { type: DataTypes.DATE, allowNull: true },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    question_order: { type: DataTypes.JSON, allowNull: false },
    option_orders: { type: DataTypes.JSON, allowNull: true },
    objective_score: marks(0),
    descriptive_score: marks(0),
    total_score: marks(0),
    max_score: marks(0),
    pending_evaluations: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    rank: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    percentile: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('exam_attempts', ['exam_id', 'student_user_id'], { unique: true });
  await qi.addIndex('exam_attempts', ['institute_id', 'student_user_id']);
  await qi.addIndex('exam_attempts', ['institute_id', 'status', 'deadline_at']);

  await qi.createTable('exam_answers', {
    id: id(),
    ...tenantColumns(),
    attempt_id: fk('exam_attempts'),
    exam_question_id: fk('exam_questions'),
    /** The student's original response; frozen once the attempt is submitted. */
    response: { type: DataTypes.JSON, allowNull: true },
    marked_for_review: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    visited: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    time_spent_seconds: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    auto_score: marks(null),
    is_correct: { type: DataTypes.BOOLEAN, allowNull: true },
    saved_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('exam_answers', ['attempt_id', 'exam_question_id'], { unique: true });
  await qi.addIndex('exam_answers', ['institute_id', 'exam_question_id']);

  await qi.createTable('exam_answer_pages', {
    id: id(),
    ...tenantColumns(),
    answer_id: fk('exam_answers'),
    file_id: { ...fk('files'), onDelete: 'RESTRICT' },
    page_no: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('exam_answer_pages', ['institute_id', 'answer_id']);

  await qi.createTable('grading_jobs', {
    id: id(),
    ...tenantColumns(),
    exam_id: fk('exams'),
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'queued' },
    mode: { type: DataTypes.STRING(12), allowNull: false },
    prompt_version_id: fk('prompt_versions', { allowNull: true }),
    total: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    processed: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    failed: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    requested_by_user_id: fk('users', { allowNull: true }),
    started_at: { type: DataTypes.DATE, allowNull: true },
    finished_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('grading_jobs', ['institute_id', 'exam_id']);

  await qi.createTable('grading_results', {
    id: id(),
    ...tenantColumns(),
    grading_job_id: fk('grading_jobs'),
    answer_id: fk('exam_answers'),
    prompt_version_id: fk('prompt_versions', { allowNull: true }),
    status: { type: DataTypes.STRING(10), allowNull: false },
    model: { type: DataTypes.STRING(150), allowNull: true },
    marks: marks(null),
    feedback: { type: DataTypes.TEXT, allowNull: true },
    confidence: { type: DataTypes.DECIMAL(4, 3), allowNull: true },
    /** Unmodified model output, kept for audit. */
    raw_output: { type: DataTypes.TEXT, allowNull: true },
    total_tokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    used_vision: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('grading_results', ['institute_id', 'answer_id']);
  await qi.addIndex('grading_results', ['institute_id', 'grading_job_id']);

  await qi.createTable('exam_evaluations', {
    id: id(),
    ...tenantColumns(),
    answer_id: fk('exam_answers'),
    status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'pending' },
    ai_result_id: fk('grading_results', { allowNull: true }),
    ai_marks: marks(null),
    ai_feedback: { type: DataTypes.TEXT, allowNull: true },
    teacher_marks: marks(null),
    teacher_feedback: { type: DataTypes.TEXT, allowNull: true },
    evaluated_by_user_id: fk('users', { allowNull: true }),
    evaluated_at: { type: DataTypes.DATE, allowNull: true },
    final_marks: marks(null),
    ...timestamps(),
  });
  await qi.addIndex('exam_evaluations', ['answer_id'], { unique: true });
  await qi.addIndex('exam_evaluations', ['institute_id', 'status']);

  await qi.createTable('exam_result_corrections', {
    id: id(),
    ...tenantColumns(),
    attempt_id: fk('exam_attempts'),
    answer_id: fk('exam_answers'),
    before_marks: marks(null),
    after_marks: marks(0),
    reason: { type: DataTypes.STRING(1000), allowNull: false },
    corrected_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('exam_result_corrections', ['institute_id', 'attempt_id']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const t of [
    'exam_result_corrections',
    'exam_evaluations',
    'grading_results',
    'grading_jobs',
    'exam_answer_pages',
    'exam_answers',
    'exam_attempts',
    'exam_questions',
    'exam_sections',
    'exams',
    'prompt_versions',
  ])
    await qi.dropTable(t);
};
