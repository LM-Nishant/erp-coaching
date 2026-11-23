import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('doubts', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    student_user_id: fk('users'),
    teacher_user_id: fk('users', { allowNull: true }),
    batch_id: fk('batches', { allowNull: true }),
    subject_id: fk('subjects', { allowNull: true }),
    lecture_id: fk('lms_resources', { allowNull: true }),
    position_seconds: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    live_class_id: fk('live_sessions', { allowNull: true }),
    question: { type: DataTypes.TEXT, allowNull: false },
    file_id: fk('files', { allowNull: true }),
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'open' },
    reply_count: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    last_activity_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    answered_at: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('doubts', ['institute_id', 'student_user_id', 'last_activity_at']);
  await queryInterface.addIndex('doubts', ['institute_id', 'teacher_user_id', 'status']);
  await queryInterface.addIndex('doubts', ['institute_id', 'batch_id', 'status']);
  await queryInterface.addIndex('doubts', ['institute_id', 'status', 'last_activity_at']);

  await queryInterface.createTable('doubt_replies', {
    id: id(),
    ...tenantColumns(),
    doubt_id: fk('doubts'),
    author_user_id: fk('users', { allowNull: true }),
    from_teacher: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    body: { type: DataTypes.TEXT, allowNull: true },
    file_id: fk('files', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('doubt_replies', ['institute_id', 'doubt_id']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('doubt_replies');
  await queryInterface.dropTable('doubts');
};
