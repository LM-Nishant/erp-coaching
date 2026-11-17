import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const date = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
/** Common columns for per-employee child tables. */
const child = () => ({ id: id(), ...tenantColumns(), employee_id: fk('employees') });

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('shifts', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    name: str(100, false),
    start_time: { type: DataTypes.STRING(5), allowNull: false },
    end_time: { type: DataTypes.STRING(5), allowNull: false },
    grace_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 10 },
    weekly_offs: { type: DataTypes.JSON, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await q.addIndex('shifts', ['institute_id', 'name']);

  await q.createTable('employees', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    user_id: fk('users', { allowNull: true }),
    employee_code: str(30, false),
    name: str(150, false),
    email: str(150),
    mobile: str(20),
    designation: str(100),
    department: str(100),
    employment_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'full_time' },
    is_teacher: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    date_of_joining: date(false),
    date_of_birth: date(),
    date_of_exit: date(),
    gender: str(20),
    address: { type: DataTypes.TEXT, allowNull: true },
    pan: str(20),
    uan: str(20),
    esi_number: str(30),
    bank_account_name: str(150),
    bank_account_number: str(40),
    bank_ifsc: str(20),
    shift_id: fk('shifts', { allowNull: true }),
    biometric_enrolment_id: str(50),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    notes: { type: DataTypes.TEXT, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('employees', ['institute_id', 'employee_code'], { unique: true });
  await q.addIndex('employees', ['institute_id', 'user_id'], { unique: true });
  await q.addIndex('employees', ['institute_id', 'biometric_enrolment_id'], { unique: true });
  await q.addIndex('employees', ['institute_id', 'branch_id', 'status']);

  await q.createTable('employee_qualifications', {
    ...child(),
    degree: str(150, false),
    institution: str(200),
    year_of_passing: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    grade: str(30),
    ...timestamps(),
  });
  await q.addIndex('employee_qualifications', ['institute_id', 'employee_id']);

  await q.createTable('employee_experiences', {
    ...child(),
    organisation: str(200, false),
    role: str(150),
    from_date: date(),
    to_date: date(),
    notes: { type: DataTypes.TEXT, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('employee_experiences', ['institute_id', 'employee_id']);

  await q.createTable('employee_documents', {
    ...child(),
    file_id: fk('files', { onDelete: 'RESTRICT' }),
    doc_type: str(50, false),
    title: str(200, false),
    ...timestamps(),
  });
  await q.addIndex('employee_documents', ['institute_id', 'employee_id']);

  await q.createTable('employee_assignments', {
    ...child(),
    branch_id: fk('branches', { onDelete: 'RESTRICT' }),
    role: str(100, false),
    // Free reference to courses/batches/subjects owned by other modules (no FK by design).
    reference_type: str(40),
    reference_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    from_date: date(),
    to_date: date(),
    ...timestamps(),
  });
  await q.addIndex('employee_assignments', ['institute_id', 'employee_id']);

  await q.createTable('employment_contracts', {
    ...child(),
    contract_type: str(30, false),
    start_date: date(false),
    end_date: date(),
    probation_months: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    notice_period_days: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 30 },
    terms: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    ...timestamps(),
  });
  await q.addIndex('employment_contracts', ['institute_id', 'employee_id']);

  await q.createTable('leave_types', {
    id: id(),
    ...tenantColumns(),
    code: str(20, false),
    name: str(100, false),
    annual_quota: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    paid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    encashable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await q.addIndex('leave_types', ['institute_id', 'code'], { unique: true });

  await q.createTable('leave_applications', {
    ...child(),
    leave_type_id: fk('leave_types', { onDelete: 'RESTRICT' }),
    from_date: date(false),
    to_date: date(false),
    half_day: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    days: { type: DataTypes.DECIMAL(5, 1), allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    decided_by: fk('users', { allowNull: true }),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    decision_note: str(500),
    ...timestamps(),
  });
  await q.addIndex('leave_applications', ['institute_id', 'employee_id', 'from_date']);
  await q.addIndex('leave_applications', ['institute_id', 'status']);

  await q.createTable('staff_attendance', {
    ...child(),
    date: date(false),
    status: { type: DataTypes.STRING(20), allowNull: false },
    check_in: { type: DataTypes.STRING(5), allowNull: true },
    check_out: { type: DataTypes.STRING(5), allowNull: true },
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
    leave_application_id: fk('leave_applications', { allowNull: true }),
    remarks: str(255),
    ...timestamps(),
  });
  await q.addIndex('staff_attendance', ['institute_id', 'employee_id', 'date'], { unique: true });
  await q.addIndex('staff_attendance', ['institute_id', 'date']);

  await q.createTable('employee_assets', {
    ...child(),
    name: str(150, false),
    asset_tag: str(60),
    issued_on: date(false),
    returned_on: date(),
    value_paise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'issued' },
    notes: str(500),
    ...timestamps(),
  });
  await q.addIndex('employee_assets', ['institute_id', 'employee_id']);

  await q.createTable('employee_separations', {
    ...child(),
    type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'resignation' },
    submitted_on: date(false),
    notice_period_days: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    last_working_day: date(false),
    reason: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'submitted' },
    decided_by: fk('users', { allowNull: true }),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('employee_separations', ['institute_id', 'employee_id']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  for (const t of [
    'employee_separations',
    'employee_assets',
    'staff_attendance',
    'leave_applications',
    'leave_types',
    'employment_contracts',
    'employee_assignments',
    'employee_documents',
    'employee_experiences',
    'employee_qualifications',
    'employees',
    'shifts',
  ])
    await q.dropTable(t);
};
