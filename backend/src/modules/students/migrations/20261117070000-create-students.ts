import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('students', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    user_id: fk('users', { allowNull: true }),
    admission_number: { type: DataTypes.STRING(60), allowNull: false },
    roll_number: { type: DataTypes.STRING(60), allowNull: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    mobile: { type: DataTypes.STRING(20), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: true },
    date_of_birth: { type: DataTypes.DATEONLY, allowNull: true },
    gender: { type: DataTypes.STRING(10), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    city: { type: DataTypes.STRING(80), allowNull: true },
    state: { type: DataTypes.STRING(80), allowNull: true },
    pincode: { type: DataTypes.STRING(12), allowNull: true },
    id_type: { type: DataTypes.STRING(40), allowNull: true },
    id_number: { type: DataTypes.STRING(60), allowNull: true },
    photo_file_id: fk('files', { allowNull: true }),
    academic_info: { type: DataTypes.JSON, allowNull: true },
    custom_fields: { type: DataTypes.JSON, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    status_reason: { type: DataTypes.STRING(255), allowNull: true },
    source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'admin' },
    admitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps(),
  });
  await queryInterface.addIndex('students', ['institute_id', 'admission_number'], { unique: true });
  await queryInterface.addIndex('students', ['institute_id', 'roll_number'], { unique: true });
  await queryInterface.addIndex('students', ['institute_id', 'user_id'], { unique: true });
  await queryInterface.addIndex('students', ['institute_id', 'branch_id', 'status']);
  await queryInterface.addIndex('students', ['institute_id', 'mobile']);
  await queryInterface.addIndex('students', ['institute_id', 'email']);
  await queryInterface.addIndex('students', ['institute_id', 'id_number']);

  /** Concurrency-safe counters for admission/roll numbers (one row per institute, kind and rendered prefix). */
  await queryInterface.createTable('admission_sequences', {
    id: id(),
    ...tenantColumns(),
    kind: { type: DataTypes.STRING(20), allowNull: false },
    scope_key: { type: DataTypes.STRING(120), allowNull: false },
    last_value: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await queryInterface.addIndex('admission_sequences', ['institute_id', 'kind', 'scope_key'], {
    unique: true,
  });

  await queryInterface.createTable('student_documents', {
    id: id(),
    ...tenantColumns(),
    student_id: fk('students'),
    file_id: fk('files', { onDelete: 'CASCADE' }),
    doc_type: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'other' },
    title: { type: DataTypes.STRING(150), allowNull: true },
    uploaded_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('student_documents', ['institute_id', 'student_id']);

  await queryInterface.createTable('student_history', {
    id: id(),
    ...tenantColumns(),
    student_id: fk('students'),
    event_type: { type: DataTypes.STRING(40), allowNull: false },
    from_value: { type: DataTypes.STRING(150), allowNull: true },
    to_value: { type: DataTypes.STRING(150), allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    actor_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('student_history', ['institute_id', 'student_id', 'created_at']);

  await queryInterface.createTable('student_academic_records', {
    id: id(),
    ...tenantColumns(),
    student_id: fk('students'),
    academic_year: { type: DataTypes.STRING(20), allowNull: true },
    institution: { type: DataTypes.STRING(150), allowNull: true },
    class_grade: { type: DataTypes.STRING(40), allowNull: true },
    board: { type: DataTypes.STRING(60), allowNull: true },
    result: { type: DataTypes.STRING(60), allowNull: true },
    percentage: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    remarks: { type: DataTypes.STRING(255), allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('student_academic_records', ['institute_id', 'student_id']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('student_academic_records');
  await queryInterface.dropTable('student_history');
  await queryInterface.dropTable('student_documents');
  await queryInterface.dropTable('admission_sequences');
  await queryInterface.dropTable('students');
};
