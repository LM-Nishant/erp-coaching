import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

/**
 * One row per online course purchase (fee account): the admission and batch enrolment it produced.
 * `awaiting_batch` rows are the admin queue of paid students no batch could take yet.
 */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('fee_course_enrolments', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    account_id: fk('fee_accounts'),
    student_id: fk('students'),
    student_user_id: fk('users', { allowNull: true }),
    course_id: fk('courses'),
    requested_batch_id: fk('batches', { allowNull: true }),
    batch_id: fk('batches', { allowNull: true }),
    application_id: fk('admission_applications', { allowNull: true }),
    status: { type: DataTypes.STRING(20), allowNull: false },
    added_to_batch: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    reason: { type: DataTypes.STRING(30), allowNull: true },
    enrolled_at: { type: DataTypes.DATE, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    notified_at: { type: DataTypes.DATE, allowNull: true },
    assigned_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('fee_course_enrolments', ['institute_id', 'account_id'], { unique: true });
  await q.addIndex('fee_course_enrolments', ['institute_id', 'status', 'branch_id']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.dropTable('fee_course_enrolments');
};
