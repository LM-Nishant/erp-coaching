import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const date = (allowNull = false) => ({ type: DataTypes.DATEONLY, allowNull });
const time = () => ({ type: DataTypes.TIME, allowNull: false });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const bool = (defaultValue = false) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });

/** Creation order; `down` drops in reverse. */
const TABLES = [
  'academic_sessions',
  'course_categories',
  'courses',
  'course_branches',
  'subjects',
  'course_subjects',
  'chapters',
  'topics',
  'batches',
  'batch_teachers',
  'batch_students',
  'student_promotions',
  'classrooms',
  'class_schedules',
  'class_sessions',
  'class_notes',
  'class_note_attachments',
  'class_note_comments',
];

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('academic_sessions', {
    id: id(),
    ...tenantColumns(),
    name: str(80),
    start_date: date(),
    end_date: date(),
    is_current: bool(),
    status: { ...str(20), defaultValue: 'planned' },
    ...timestamps(),
  });
  await qi.addIndex('academic_sessions', ['institute_id', 'name'], { unique: true });

  await qi.createTable('course_categories', {
    id: id(),
    ...tenantColumns(),
    name: str(120),
    description: { type: DataTypes.TEXT, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('course_categories', ['institute_id', 'name'], { unique: true });

  await qi.createTable('courses', {
    id: id(),
    ...tenantColumns(),
    category_id: fk('course_categories', { allowNull: true }),
    template_id: fk('courses', { allowNull: true }),
    name: str(150),
    code: str(30),
    description: { type: DataTypes.TEXT, allowNull: true },
    mode: { ...str(10), defaultValue: 'offline' },
    duration_value: uint(),
    duration_unit: str(10, true),
    is_template: bool(),
    status: { ...str(20), defaultValue: 'active' },
    ...timestamps(),
  });
  await qi.addIndex('courses', ['institute_id', 'code'], { unique: true });

  await qi.createTable('course_branches', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    course_id: fk('courses'),
    ...timestamps(),
  });
  await qi.addIndex('course_branches', ['institute_id', 'course_id', 'branch_id'], { unique: true });

  await qi.createTable('subjects', {
    id: id(),
    ...tenantColumns(),
    name: str(120),
    code: str(30, true),
    ...timestamps(),
  });
  await qi.addIndex('subjects', ['institute_id', 'name'], { unique: true });

  await qi.createTable('course_subjects', {
    id: id(),
    ...tenantColumns(),
    course_id: fk('courses'),
    subject_id: fk('subjects', { onDelete: 'RESTRICT' }),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('course_subjects', ['institute_id', 'course_id', 'subject_id'], { unique: true });

  await qi.createTable('chapters', {
    id: id(),
    ...tenantColumns(),
    subject_id: fk('subjects'),
    name: str(150),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('chapters', ['institute_id', 'subject_id', 'sort_order']);

  await qi.createTable('topics', {
    id: id(),
    ...tenantColumns(),
    chapter_id: fk('chapters'),
    name: str(150),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    duration_minutes: uint(),
    ...timestamps(),
  });
  await qi.addIndex('topics', ['institute_id', 'chapter_id', 'sort_order']);

  await qi.createTable('batches', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    course_id: fk('courses', { onDelete: 'RESTRICT' }),
    academic_session_id: fk('academic_sessions', { onDelete: 'RESTRICT' }),
    name: str(120),
    code: str(30),
    capacity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    start_date: date(),
    end_date: date(true),
    mode: { ...str(10), defaultValue: 'offline' },
    status: { ...str(20), defaultValue: 'planned' },
    ...timestamps(),
  });
  await qi.addIndex('batches', ['institute_id', 'code'], { unique: true });
  await qi.addIndex('batches', ['institute_id', 'branch_id', 'academic_session_id']);

  await qi.createTable('batch_teachers', {
    id: id(),
    ...tenantColumns(),
    batch_id: fk('batches'),
    subject_id: fk('subjects', { allowNull: true }),
    teacher_user_id: fk('users'),
    ...timestamps(),
  });
  await qi.addIndex('batch_teachers', ['institute_id', 'batch_id']);
  await qi.addIndex('batch_teachers', ['institute_id', 'teacher_user_id']);

  await qi.createTable('batch_students', {
    id: id(),
    ...tenantColumns(),
    batch_id: fk('batches', { onDelete: 'RESTRICT' }),
    student_user_id: fk('users', { onDelete: 'RESTRICT' }),
    status: { ...str(20), defaultValue: 'active' },
    joined_on: date(),
    left_on: date(true),
    promoted_from_id: fk('batch_students', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('batch_students', ['institute_id', 'batch_id', 'status']);
  await qi.addIndex('batch_students', ['institute_id', 'student_user_id']);

  await qi.createTable('student_promotions', {
    id: id(),
    ...tenantColumns(),
    student_user_id: fk('users', { onDelete: 'RESTRICT' }),
    from_batch_id: fk('batches', { onDelete: 'RESTRICT' }),
    to_batch_id: fk('batches', { onDelete: 'RESTRICT' }),
    from_session_id: fk('academic_sessions', { onDelete: 'RESTRICT' }),
    to_session_id: fk('academic_sessions', { onDelete: 'RESTRICT' }),
    promoted_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('student_promotions', ['institute_id', 'student_user_id']);

  await qi.createTable('classrooms', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    name: str(80),
    capacity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    is_virtual: bool(),
    status: { ...str(20), defaultValue: 'active' },
    ...timestamps(),
  });
  await qi.addIndex('classrooms', ['institute_id', 'branch_id', 'name'], { unique: true });

  await qi.createTable('class_schedules', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    batch_id: fk('batches'),
    subject_id: fk('subjects', { allowNull: true }),
    teacher_user_id: fk('users', { onDelete: 'RESTRICT' }),
    classroom_id: fk('classrooms', { allowNull: true }),
    day_of_week: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    start_time: time(),
    end_time: time(),
    effective_from: date(),
    effective_to: date(true),
    ...timestamps(),
  });
  await qi.addIndex('class_schedules', ['institute_id', 'day_of_week', 'teacher_user_id']);
  await qi.addIndex('class_schedules', ['institute_id', 'day_of_week', 'classroom_id']);
  await qi.addIndex('class_schedules', ['institute_id', 'batch_id']);

  await qi.createTable('class_sessions', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    batch_id: fk('batches', { onDelete: 'RESTRICT' }),
    subject_id: fk('subjects', { allowNull: true }),
    schedule_id: fk('class_schedules', { allowNull: true }),
    teacher_user_id: fk('users', { onDelete: 'RESTRICT' }),
    original_teacher_user_id: fk('users', { allowNull: true }),
    classroom_id: fk('classrooms', { allowNull: true }),
    /** Day the schedule generated this occurrence for; unchanged when rescheduled. */
    occurrence_date: date(true),
    date: date(),
    start_time: time(),
    end_time: time(),
    status: { ...str(20), defaultValue: 'scheduled' },
    rescheduled_from: str(40, true),
    cancel_reason: str(500, true),
    actual_duration_minutes: uint(),
    completion_notes: { type: DataTypes.TEXT, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('class_sessions', ['institute_id', 'date', 'teacher_user_id']);
  await qi.addIndex('class_sessions', ['institute_id', 'date', 'classroom_id']);
  await qi.addIndex('class_sessions', ['institute_id', 'batch_id', 'date']);
  // One generated occurrence per schedule per day (NULL schedule_id = ad-hoc extra classes).
  await qi.addIndex('class_sessions', ['schedule_id', 'occurrence_date'], {
    unique: true,
    name: 'class_sessions_schedule_occurrence_unique',
  });

  await qi.createTable('class_notes', {
    id: id(),
    ...tenantColumns(),
    class_session_id: fk('class_sessions'),
    author_user_id: fk('users', { onDelete: 'RESTRICT' }),
    kind: { ...str(20), defaultValue: 'note' },
    title: str(200),
    body: { type: DataTypes.TEXT, allowNull: true },
    due_date: date(true),
    ...timestamps(),
  });
  await qi.addIndex('class_notes', ['institute_id', 'class_session_id']);

  await qi.createTable('class_note_attachments', {
    id: id(),
    ...tenantColumns(),
    class_note_id: fk('class_notes'),
    file_id: fk('files', { onDelete: 'RESTRICT' }),
    ...timestamps(),
  });
  await qi.addIndex('class_note_attachments', ['institute_id', 'class_note_id']);

  await qi.createTable('class_note_comments', {
    id: id(),
    ...tenantColumns(),
    class_note_id: fk('class_notes'),
    user_id: fk('users'),
    body: { type: DataTypes.TEXT, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('class_note_comments', ['institute_id', 'class_note_id']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const table of [...TABLES].reverse()) await qi.dropTable(table);
};
