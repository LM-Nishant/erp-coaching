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
const int = (defaultValue = 0) => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue });
/** Money is stored as integer paise. */
const money = () => ({ type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
const userFk = () => fk('users', { allowNull: true });
/**
 * `branch_id ?? 0`, kept by the service so the unique keys below also hold for institute-level
 * rows (MySQL treats NULLs in a unique index as distinct).
 */
const branchScope = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });

const TABLES = [
  'tally_settings',
  'tally_ledger_mappings',
  'tally_known_ledgers',
  'tally_exports',
  'tally_export_vouchers',
];

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  // Institute-wide (branch_id NULL) or per-branch overrides of the export settings.
  await q.createTable('tally_settings', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    branch_scope: branchScope(),
    company_name: str(150),
    receivable_mode: str(10),
    gst_ledgers: str(10),
    voucher_types: json(),
    updated_by_user_id: userFk(),
    ...timestamps(),
  });
  await q.addIndex('tally_settings', ['institute_id', 'branch_scope'], { unique: true });

  // App ledger account → Tally ledger name and group, institute-wide or per branch.
  await q.createTable('tally_ledger_mappings', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    branch_scope: branchScope(),
    account: str(60, false),
    tally_name: str(100, false),
    parent_group: str(100, false),
    updated_by_user_id: userFk(),
    ...timestamps(),
  });
  await q.addIndex('tally_ledger_mappings', ['institute_id', 'branch_scope', 'account'], { unique: true });

  // Ledgers and groups read from a list exported from Tally; an import replaces the scope's list.
  await q.createTable('tally_known_ledgers', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    branch_scope: branchScope(),
    kind: str(10, false),
    name: str(200, false),
    parent: str(200),
    ...timestamps(),
  });
  await q.addIndex('tally_known_ledgers', ['institute_id', 'branch_scope', 'kind']);

  // One row per export batch (branch_id NULL = all branches), with what it contained.
  await q.createTable('tally_exports', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    from_date: date(false),
    to_date: date(false),
    only_new: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    company_name: str(150),
    receivable_mode: { ...str(10, false), defaultValue: 'control' },
    voucher_count: int(),
    skipped_count: int(),
    already_exported_count: int(),
    ledger_count: int(),
    total_amount: money(),
    totals: json(),
    type_counts: json(),
    masters: json(),
    created_by_user_id: userFk(),
    ...timestamps(),
  });
  await q.addIndex('tally_exports', ['institute_id', 'created_at']);

  // Every journal the batch covered: `exported` (in the file), `skipped` (nets to zero in Tally) or
  // `previous` (already exported unchanged, left out of an "only new" batch). The XML is rebuilt
  // from the `exported` rows on download.
  await q.createTable('tally_export_vouchers', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    export_id: fk('tally_exports'),
    journal_key: str(120, false),
    ref_type: str(30, false),
    ref_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    entry_date: date(false),
    voucher_type: str(60, false),
    voucher_number: str(60),
    remote_id: str(64, false),
    party_ledger: str(200),
    narration: str(500),
    lines: json(false),
    amount: money(),
    fingerprint: { type: DataTypes.CHAR(64), allowNull: false },
    content_digest: { type: DataTypes.CHAR(64), allowNull: false },
    status: { ...str(10, false), defaultValue: 'exported' },
    skip_reason: str(120),
    ...timestamps(),
  });
  await q.addIndex('tally_export_vouchers', ['export_id', 'entry_date']);
  await q.addIndex('tally_export_vouchers', ['institute_id', 'journal_key']);

  // Exports read the ledger by period across all accounts.
  await q.addIndex('fee_ledger_entries', ['institute_id', 'entry_date'], {
    name: 'fee_ledger_entries_institute_id_entry_date',
  });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.removeIndex('fee_ledger_entries', 'fee_ledger_entries_institute_id_entry_date');
  for (const t of [...TABLES].reverse()) await q.dropTable(t);
};
