import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('admission_forms', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    purpose: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'admission' },
    fields: { type: DataTypes.JSON, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('admission_forms', ['institute_id', 'purpose', 'is_active']);

  // course_id has no FK yet: the academics module owns `courses` (added once it is merged).
  await queryInterface.createTable('enquiries', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    mobile: { type: DataTypes.STRING(20), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: true },
    source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'walk_in' },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new' },
    counsellor_user_id: fk('users', { allowNull: true }),
    course_interest: { type: DataTypes.STRING(150), allowNull: true },
    course_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    next_follow_up_at: { type: DataTypes.DATE, allowNull: true },
    student_id: fk('students', { allowNull: true }),
    custom_fields: { type: DataTypes.JSON, allowNull: true },
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('enquiries', ['institute_id', 'branch_id', 'status']);
  await queryInterface.addIndex('enquiries', ['institute_id', 'mobile']);
  await queryInterface.addIndex('enquiries', ['institute_id', 'counsellor_user_id']);

  await queryInterface.createTable('enquiry_follow_ups', {
    id: id(),
    ...tenantColumns(),
    enquiry_id: fk('enquiries'),
    note: { type: DataTypes.TEXT, allowNull: true },
    outcome: { type: DataTypes.STRING(40), allowNull: true },
    scheduled_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    reminded_at: { type: DataTypes.DATE, allowNull: true },
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('enquiry_follow_ups', ['institute_id', 'enquiry_id']);

  await queryInterface.createTable('admission_applications', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    enquiry_id: fk('enquiries', { allowNull: true }),
    form_id: fk('admission_forms', { allowNull: true }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    mobile: { type: DataTypes.STRING(20), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: true },
    course_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    batch_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    waitlist_position: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true },
    student_id: fk('students', { allowNull: true }),
    remarks: { type: DataTypes.STRING(255), allowNull: true },
    decided_by_user_id: fk('users', { allowNull: true }),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('admission_applications', ['institute_id', 'branch_id', 'status']);
  await queryInterface.addIndex('admission_applications', ['institute_id', 'mobile']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('admission_applications');
  await queryInterface.dropTable('enquiry_follow_ups');
  await queryInterface.dropTable('enquiries');
  await queryInterface.dropTable('admission_forms');
};
