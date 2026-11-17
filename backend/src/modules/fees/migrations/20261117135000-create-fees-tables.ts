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
const json = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const int = (defaultValue = 0) => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue });
/** Money is stored as integer paise. */
const money = (allowNull = false) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
});
const optFk = (table: string) => fk(table, { allowNull: true });
const userFk = () => fk('users', { allowNull: true });

const TABLES = [
  'fee_settings',
  'fee_heads',
  'fee_structures',
  'fee_concession_rules',
  'fee_accounts',
  'fee_instalments',
  'fee_adjustments',
  'payment_gateway_configs',
  'bank_accounts',
  'fee_payments',
  'fee_payment_allocations',
  'fee_receipts',
  'fee_refunds',
  'fee_sequences',
  'fee_ledger_entries',
  'fee_entitlements',
  'fee_webhook_events',
  'finance_categories',
  'finance_entries',
  'bank_statement_lines',
];

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('fee_settings', {
    id: id(),
    ...tenantColumns(),
    settings: json(false),
    ...timestamps(),
  });
  await q.addIndex('fee_settings', ['institute_id'], { unique: true });

  await q.createTable('fee_heads', {
    id: id(),
    ...tenantColumns(),
    name: str(100, false),
    code: str(30, false),
    taxable: bool(true),
    active: bool(true),
    sort_order: int(),
    ...timestamps(),
  });
  await q.addIndex('fee_heads', ['institute_id', 'code'], { unique: true });

  // Versioned: a new version archives the previous one; accounts keep pointing at their version.
  await q.createTable('fee_structures', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    family_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    version: int(1),
    kind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'course' },
    course_id: optFk('courses'),
    batch_id: optFk('batches'),
    subject_id: optFk('subjects'),
    academic_session_id: optFk('academic_sessions'),
    name: str(150, false),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
    effective_from: date(false),
    components: json(false),
    total: money(),
    instalment_plan: json(false),
    created_by_user_id: userFk(),
    ...timestamps(),
  });
  await q.addIndex('fee_structures', ['institute_id', 'status', 'course_id', 'batch_id']);
  await q.addIndex('fee_structures', ['institute_id', 'family_id', 'version']);

  await q.createTable('fee_concession_rules', {
    id: id(),
    ...tenantColumns(),
    name: str(120, false),
    type: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'concession' },
    mode: { type: DataTypes.STRING(10), allowNull: false },
    value: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
    requires_approval: bool(true),
    active: bool(true),
    description: str(500),
    ...timestamps(),
  });
  await q.addIndex('fee_concession_rules', ['institute_id', 'active']);

  await q.createTable('fee_accounts', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    student_id: fk('students'),
    student_user_id: userFk(),
    structure_id: fk('fee_structures', { allowNull: true }),
    course_id: optFk('courses'),
    batch_id: optFk('batches'),
    subject_id: optFk('subjects'),
    academic_session_id: optFk('academic_sessions'),
    title: str(150, false),
    gross: money(),
    taxable_gross: money(),
    discount: money(),
    charges: money(),
    late_fee: money(),
    paid: money(),
    advance: money(),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
    /** Idempotency key of automatic generation (e.g. `admission:12`). */
    source_ref: str(80),
    ...timestamps(),
  });
  await q.addIndex('fee_accounts', ['institute_id', 'student_id']);
  await q.addIndex('fee_accounts', ['institute_id', 'source_ref'], { unique: true });
  await q.addIndex('fee_accounts', ['institute_id', 'branch_id', 'status']);

  await q.createTable('fee_instalments', {
    id: id(),
    ...tenantColumns(),
    account_id: fk('fee_accounts'),
    seq: int(1),
    label: str(60, false),
    due_date: date(false),
    amount: money(),
    late_fee: money(),
    paid: money(),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
    overdue_notified_at: { type: DataTypes.DATE, allowNull: true },
    late_fee_applied_on: date(),
    ...timestamps(),
  });
  await q.addIndex('fee_instalments', ['institute_id', 'account_id', 'seq'], { unique: true });
  await q.addIndex('fee_instalments', ['institute_id', 'status', 'due_date']);

  await q.createTable('fee_adjustments', {
    id: id(),
    ...tenantColumns(),
    account_id: fk('fee_accounts'),
    rule_id: fk('fee_concession_rules', { allowNull: true }),
    type: { type: DataTypes.STRING(15), allowNull: false },
    mode: { type: DataTypes.STRING(10), allowNull: false },
    value: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    amount: money(),
    reason: str(500),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    requested_by_user_id: userFk(),
    decided_by_user_id: userFk(),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('fee_adjustments', ['institute_id', 'account_id']);
  await q.addIndex('fee_adjustments', ['institute_id', 'status']);

  await q.createTable('payment_gateway_configs', {
    id: id(),
    ...tenantColumns(),
    gateway: str(20, false),
    enabled: bool(true),
    is_default: bool(false),
    merchant_id: str(120),
    /** AES-256-GCM encrypted JSON `{ secretKey, webhookSecret, extra }`. */
    secret_encrypted: { type: DataTypes.TEXT, allowNull: true },
    key_hint: str(20),
    sandbox: bool(true),
    /** Random path segment identifying the institute on public webhook URLs. */
    webhook_key: str(64, false),
    ...timestamps(),
  });
  await q.addIndex('payment_gateway_configs', ['institute_id', 'gateway'], { unique: true });
  await q.addIndex('payment_gateway_configs', ['webhook_key'], { unique: true });

  await q.createTable('bank_accounts', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    name: str(120, false),
    bank_name: str(120),
    account_number_last4: str(4),
    ifsc: str(15),
    opening_balance: money(),
    active: bool(true),
    ...timestamps(),
  });
  await q.addIndex('bank_accounts', ['institute_id', 'branch_id']);

  await q.createTable('fee_payments', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    account_id: fk('fee_accounts', { onDelete: 'RESTRICT' }),
    student_id: fk('students', { onDelete: 'RESTRICT' }),
    amount: money(),
    mode: str(15, false),
    gateway: str(20),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    approval_status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'not_required' },
    reference_no: str(120),
    cheque_number: str(30),
    cheque_date: date(),
    bank_name: str(120),
    paid_on: date(),
    gateway_order_id: str(120),
    gateway_payment_id: str(120),
    gateway_charge: money(),
    gateway_payload: json(),
    refunded: money(),
    idempotency_key: str(120),
    bank_account_id: fk('bank_accounts', { allowNull: true }),
    receipt_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    recorded_by_user_id: userFk(),
    approved_by_user_id: userFk(),
    notes: str(500),
    posted_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('fee_payments', ['institute_id', 'idempotency_key'], { unique: true });
  await q.addIndex('fee_payments', ['gateway', 'gateway_order_id'], { unique: true });
  await q.addIndex('fee_payments', ['institute_id', 'account_id']);
  await q.addIndex('fee_payments', ['institute_id', 'status', 'paid_on']);

  await q.createTable('fee_payment_allocations', {
    id: id(),
    ...tenantColumns(),
    payment_id: fk('fee_payments'),
    instalment_id: fk('fee_instalments'),
    amount: money(),
    ...timestamps(),
  });
  await q.addIndex('fee_payment_allocations', ['institute_id', 'payment_id']);

  await q.createTable('fee_receipts', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    number: str(120, false),
    invoice_number: str(120),
    payment_id: fk('fee_payments', { onDelete: 'RESTRICT' }),
    account_id: fk('fee_accounts', { onDelete: 'RESTRICT' }),
    student_id: fk('students', { onDelete: 'RESTRICT' }),
    amount: money(),
    taxable_value: money(),
    cgst: money(),
    sgst: money(),
    igst: money(),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'issued' },
    pdf_file_id: fk('files', { allowNull: true }),
    issued_at: { type: DataTypes.DATE, allowNull: false },
    ...timestamps(),
  });
  await q.addIndex('fee_receipts', ['institute_id', 'number'], { unique: true });
  await q.addIndex('fee_receipts', ['institute_id', 'payment_id'], { unique: true });

  await q.createTable('fee_refunds', {
    id: id(),
    ...tenantColumns(),
    payment_id: fk('fee_payments', { onDelete: 'RESTRICT' }),
    amount: money(),
    reason: str(500),
    reduce_dues: bool(true),
    status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'pending' },
    gateway_refund_id: str(120),
    idempotency_key: str(120, false),
    requested_by_user_id: userFk(),
    processed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('fee_refunds', ['institute_id', 'idempotency_key'], { unique: true });
  await q.addIndex('fee_refunds', ['institute_id', 'payment_id']);

  await q.createTable('fee_sequences', {
    id: id(),
    ...tenantColumns(),
    kind: str(20, false),
    scope_key: str(120, false),
    last_value: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await q.addIndex('fee_sequences', ['institute_id', 'kind', 'scope_key'], { unique: true });

  // Double-entry ledger. Every journal balances; (journal_key, line) is unique so re-posting the
  // same business event (webhook retries, double clicks) can never create duplicate entries.
  await q.createTable('fee_ledger_entries', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    journal_key: str(120, false),
    line: int(1),
    entry_date: date(false),
    account: str(60, false),
    debit: money(),
    credit: money(),
    fee_account_id: fk('fee_accounts', { allowNull: true }),
    ref_type: str(30, false),
    ref_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    narration: str(255),
    created_by_user_id: userFk(),
    ...timestamps(),
  });
  await q.addIndex('fee_ledger_entries', ['institute_id', 'journal_key', 'line'], { unique: true });
  await q.addIndex('fee_ledger_entries', ['institute_id', 'account', 'entry_date']);
  await q.addIndex('fee_ledger_entries', ['institute_id', 'fee_account_id']);

  await q.createTable('fee_entitlements', {
    id: id(),
    ...tenantColumns(),
    student_id: fk('students'),
    student_user_id: userFk(),
    course_id: optFk('courses'),
    subject_id: optFk('subjects'),
    account_id: fk('fee_accounts'),
    granted_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('fee_entitlements', ['institute_id', 'account_id'], { unique: true });
  await q.addIndex('fee_entitlements', ['institute_id', 'student_user_id', 'course_id']);

  await q.createTable('fee_webhook_events', {
    id: id(),
    ...tenantColumns(),
    gateway: str(20, false),
    event_key: str(160, false),
    gateway_order_id: str(120),
    status: str(20, false),
    payload: json(),
    ...timestamps(),
  });
  await q.addIndex('fee_webhook_events', ['institute_id', 'gateway', 'event_key'], { unique: true });

  await q.createTable('finance_categories', {
    id: id(),
    ...tenantColumns(),
    kind: str(10, false),
    name: str(100, false),
    active: bool(true),
    ...timestamps(),
  });
  await q.addIndex('finance_categories', ['institute_id', 'kind', 'name'], { unique: true });

  await q.createTable('finance_entries', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    kind: str(10, false),
    category_id: fk('finance_categories', { onDelete: 'RESTRICT' }),
    entry_date: date(false),
    amount: money(),
    tax: money(),
    mode: str(15, false),
    bank_account_id: fk('bank_accounts', { allowNull: true }),
    party: str(150),
    reference: str(120),
    notes: str(500),
    attachment_file_id: fk('files', { allowNull: true }),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'recorded' },
    recorded_by_user_id: userFk(),
    ...timestamps(),
  });
  await q.addIndex('finance_entries', ['institute_id', 'kind', 'entry_date']);

  await q.createTable('bank_statement_lines', {
    id: id(),
    ...tenantColumns(),
    bank_account_id: fk('bank_accounts'),
    txn_date: date(false),
    description: str(255),
    reference: str(120),
    amount: money(),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'unmatched' },
    matched_type: str(20),
    matched_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('bank_statement_lines', ['institute_id', 'bank_account_id', 'status']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  for (const t of [...TABLES].reverse()) await q.dropTable(t);
};
