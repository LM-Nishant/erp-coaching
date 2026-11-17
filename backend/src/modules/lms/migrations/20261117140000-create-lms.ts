import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('lms_resources', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    course_id: fk('courses'),
    subject_id: fk('subjects', { allowNull: true }),
    chapter_id: fk('chapters', { allowNull: true }),
    topic_id: fk('topics', { allowNull: true }),
    title: str(200),
    description: { type: DataTypes.TEXT, allowNull: true },
    type: str(20),
    status: { ...str(20), defaultValue: 'draft' },
    file_id: fk('files', { allowNull: true, onDelete: 'RESTRICT' }),
    external_url: str(1000, true),
    duration_seconds: uint(),
    access: { ...str(10), defaultValue: 'paid' },
    access_days: uint(),
    available_from: { type: DataTypes.DATE, allowNull: true },
    available_until: { type: DataTypes.DATE, allowNull: true },
    downloadable: bool(false),
    offline_allowed: bool(false),
    offline_expiry_hours: { ...uint(false), defaultValue: 72 },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    transcode_status: { ...str(20), defaultValue: 'none' },
    transcode_error: str(500, true),
    hls_prefix: str(300, true),
    created_by_user_id: fk('users', { allowNull: true }),
    published_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('lms_resources', ['institute_id', 'course_id', 'status']);
  await qi.addIndex('lms_resources', ['institute_id', 'subject_id', 'chapter_id', 'topic_id']);

  await qi.createTable('lms_resource_batches', {
    id: id(),
    ...tenantColumns(),
    resource_id: fk('lms_resources'),
    batch_id: fk('batches'),
    ...timestamps(),
  });
  await qi.addIndex('lms_resource_batches', ['institute_id', 'resource_id', 'batch_id'], { unique: true });

  await qi.createTable('lms_progress', {
    id: id(),
    ...tenantColumns(),
    resource_id: fk('lms_resources'),
    student_user_id: fk('users'),
    position_seconds: { ...uint(false), defaultValue: 0 },
    duration_seconds: uint(),
    watched_seconds: { ...uint(false), defaultValue: 0 },
    percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    last_viewed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('lms_progress', ['institute_id', 'resource_id', 'student_user_id'], { unique: true });
  await qi.addIndex('lms_progress', ['institute_id', 'student_user_id']);

  await qi.createTable('lms_access_grants', {
    id: id(),
    ...tenantColumns(),
    student_user_id: fk('users'),
    course_id: fk('courses'),
    valid_from: { type: DataTypes.DATE, allowNull: false },
    valid_until: { type: DataTypes.DATE, allowNull: true },
    source: { ...str(30), defaultValue: 'manual' },
    note: str(500, true),
    granted_by_user_id: fk('users', { allowNull: true }),
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('lms_access_grants', ['institute_id', 'student_user_id', 'course_id']);

  await qi.createTable('lms_upload_sessions', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    upload_id: str(36),
    user_id: fk('users'),
    file_name: str(255),
    mime_type: str(150),
    total_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    received_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    status: { ...str(20), defaultValue: 'uploading' },
    file_id: fk('files', { allowNull: true }),
    expires_at: { type: DataTypes.DATE, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('lms_upload_sessions', ['upload_id'], { unique: true });
  await qi.addIndex('lms_upload_sessions', ['institute_id', 'user_id', 'status']);

  await qi.createTable('lms_offline_licenses', {
    id: id(),
    ...tenantColumns(),
    resource_id: fk('lms_resources'),
    user_id: fk('users'),
    device_id: fk('devices'),
    content_key: str(200),
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('lms_offline_licenses', ['institute_id', 'user_id', 'resource_id']);

  await qi.createTable('lms_assignments', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    batch_id: fk('batches'),
    subject_id: fk('subjects', { allowNull: true }),
    chapter_id: fk('chapters', { allowNull: true }),
    topic_id: fk('topics', { allowNull: true }),
    title: str(200),
    instructions: { type: DataTypes.TEXT, allowNull: true },
    due_at: { type: DataTypes.DATE, allowNull: false },
    max_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
    allow_late: bool(true),
    status: { ...str(20), defaultValue: 'draft' },
    published_at: { type: DataTypes.DATE, allowNull: true },
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('lms_assignments', ['institute_id', 'batch_id', 'status', 'due_at']);

  await qi.createTable('lms_assignment_files', {
    id: id(),
    ...tenantColumns(),
    assignment_id: fk('lms_assignments'),
    file_id: { ...fk('files'), onDelete: 'RESTRICT' },
    ...timestamps(),
  });
  await qi.addIndex('lms_assignment_files', ['institute_id', 'assignment_id']);

  await qi.createTable('lms_submissions', {
    id: id(),
    ...tenantColumns(),
    assignment_id: fk('lms_assignments'),
    student_user_id: fk('users'),
    text: { type: DataTypes.TEXT, allowNull: true },
    status: { ...str(20), defaultValue: 'submitted' },
    is_late: bool(false),
    submitted_at: { type: DataTypes.DATE, allowNull: false },
    marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
    feedback: { type: DataTypes.TEXT, allowNull: true },
    graded_by_user_id: fk('users', { allowNull: true }),
    graded_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('lms_submissions', ['institute_id', 'assignment_id', 'student_user_id'], {
    unique: true,
  });

  await qi.createTable('lms_submission_files', {
    id: id(),
    ...tenantColumns(),
    submission_id: fk('lms_submissions'),
    file_id: { ...fk('files'), onDelete: 'RESTRICT' },
    ...timestamps(),
  });
  await qi.addIndex('lms_submission_files', ['institute_id', 'submission_id']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const t of [
    'lms_submission_files',
    'lms_submissions',
    'lms_assignment_files',
    'lms_assignments',
    'lms_offline_licenses',
    'lms_upload_sessions',
    'lms_access_grants',
    'lms_progress',
    'lms_resource_batches',
    'lms_resources',
  ])
    await qi.dropTable(t);
};
