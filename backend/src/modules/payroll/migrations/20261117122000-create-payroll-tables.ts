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
/** Money is stored as integer paise. */
const money = (allowNull = false) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
});
const rate = () => ({ type: DataTypes.DECIMAL(7, 3), allowNull: true });

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('salary_structures', {
    id: id(),
    ...tenantColumns(),
    employee_id: fk('employees'),
    pay_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'fixed_monthly' },
    monthly_basic: money(),
    rate_per_unit: money(),
    allowances: { type: DataTypes.JSON, allowNull: true },
    deductions: { type: DataTypes.JSON, allowNull: true },
    pf_applicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    esi_applicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    pt_applicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tds_applicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tds_percent: rate(),
    effective_from: date(false),
    effective_to: date(),
    notes: str(500),
    ...timestamps(),
  });
  await q.addIndex('salary_structures', ['institute_id', 'employee_id', 'effective_from']);

  await q.createTable('payroll_components', {
    id: id(),
    ...tenantColumns(),
    code: str(30, false),
    name: str(100, false),
    kind: { type: DataTypes.STRING(20), allowNull: false },
    statutory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    calc_type: { type: DataTypes.STRING(20), allowNull: false },
    base: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'basic' },
    employee_rate: rate(),
    employer_rate: rate(),
    fixed_amount: money(true),
    wage_ceiling: money(true),
    eligibility_max_gross: money(true),
    slabs: { type: DataTypes.JSON, allowNull: true },
    effective_from: date(false),
    effective_to: date(),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await q.addIndex('payroll_components', ['institute_id', 'code', 'effective_from'], { unique: true });

  await q.createTable('payroll_runs', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    period_year: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    period_month: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    /** 'all' or 'b<branchId>' so a period can only have one run per scope. */
    scope_key: str(20, false),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    employee_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    total_gross: money(),
    total_deductions: money(),
    total_net: money(),
    total_employer: money(),
    generated_at: { type: DataTypes.DATE, allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    approved_by: fk('users', { allowNull: true }),
    locked_at: { type: DataTypes.DATE, allowNull: true },
    locked_by: fk('users', { allowNull: true }),
    notes: str(500),
    ...timestamps(),
  });
  await q.addIndex('payroll_runs', ['institute_id', 'period_year', 'period_month', 'scope_key'], {
    unique: true,
    name: 'payroll_runs_period_scope_unique',
  });

  await q.createTable('work_units', {
    id: id(),
    ...tenantColumns(),
    employee_id: fk('employees'),
    date: date(false),
    unit_type: { type: DataTypes.STRING(20), allowNull: false },
    quantity: { type: DataTypes.DECIMAL(8, 2), allowNull: false, defaultValue: 0 },
    amount: money(),
    description: str(255),
    reference_type: str(50),
    reference_id: str(50),
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
    external_ref: str(120),
    payroll_run_id: fk('payroll_runs', { allowNull: true, onDelete: 'SET NULL' }),
    ...timestamps(),
  });
  await q.addIndex('work_units', ['institute_id', 'employee_id', 'date']);
  await q.addIndex('work_units', ['institute_id', 'external_ref'], { unique: true });

  await q.createTable('payslips', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    payroll_run_id: fk('payroll_runs'),
    employee_id: fk('employees', { onDelete: 'RESTRICT' }),
    salary_structure_id: fk('salary_structures', { allowNull: true }),
    period_year: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    period_month: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    pay_type: str(20, false),
    days_in_month: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    employed_days: { type: DataTypes.DECIMAL(5, 1), allowNull: false },
    lop_days: { type: DataTypes.DECIMAL(5, 1), allowNull: false, defaultValue: 0 },
    payable_days: { type: DataTypes.DECIMAL(5, 1), allowNull: false },
    attendance: { type: DataTypes.JSON, allowNull: true },
    units: { type: DataTypes.JSON, allowNull: true },
    lines: { type: DataTypes.JSON, allowNull: false },
    gross: money(),
    total_deductions: money(),
    net: money(),
    employer_contributions: money(),
    pdf_file_id: fk('files', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('payslips', ['payroll_run_id', 'employee_id'], { unique: true });
  await q.addIndex('payslips', ['institute_id', 'employee_id', 'period_year', 'period_month']);

  await q.createTable('final_settlements', {
    id: id(),
    ...tenantColumns(),
    employee_id: fk('employees', { onDelete: 'RESTRICT' }),
    separation_id: fk('employee_separations'),
    last_working_day: date(false),
    lines: { type: DataTypes.JSON, allowNull: false },
    net: money(),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    notes: str(500),
    approved_by: fk('users', { allowNull: true }),
    approved_at: { type: DataTypes.DATE, allowNull: true },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('final_settlements', ['separation_id'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  for (const t of [
    'final_settlements',
    'payslips',
    'work_units',
    'payroll_runs',
    'payroll_components',
    'salary_structures',
  ])
    await q.dropTable(t);
};
