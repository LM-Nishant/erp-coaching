import { DataTypes } from 'sequelize';
import {
  id,
  timestamps,
  fk,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

/**
 * SaaS billing records (invoices, payments, credit notes) are the operator's tax records: they
 * outlive a deleted institute, so their institute reference is nullable with ON DELETE SET NULL
 * and the billed party is snapshotted on each document.
 */
const retainedInstitute = () => fk('institutes', { allowNull: true, onDelete: 'SET NULL' });
const paise = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull, defaultValue: 0 });

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.addColumn('plans', 'addons', { type: DataTypes.JSON, allowNull: true });
  await q.addColumn('plans', 'usage_pricing', { type: DataTypes.JSON, allowNull: true });

  await q.addColumn('subscriptions', 'current_period_start', { type: DataTypes.DATE, allowNull: true });
  await q.addColumn('subscriptions', 'pending_plan_id', fk('plans', { allowNull: true }));
  await q.addColumn('subscriptions', 'pending_billing_cycle', {
    type: DataTypes.STRING(10),
    allowNull: true,
  });
  await q.addColumn('subscriptions', 'suspended_at', { type: DataTypes.DATE, allowNull: true });
  await q.addColumn('subscriptions', 'suspend_reason', { type: DataTypes.STRING(255), allowNull: true });
  await q.addColumn('subscriptions', 'trial_extended_days', {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
  });
  await q.addColumn('subscriptions', 'overage_billed_through', {
    type: DataTypes.DATEONLY,
    allowNull: true,
  });
  await q.addColumn('subscriptions', 'last_notice', { type: DataTypes.STRING(60), allowNull: true });
  await q.addIndex('subscriptions', ['status', 'ends_at']);

  await q.createTable('subscription_sequences', {
    id: id(),
    kind: { type: DataTypes.STRING(20), allowNull: false },
    scope_key: { type: DataTypes.STRING(60), allowNull: false },
    last_value: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await q.addIndex('subscription_sequences', ['kind', 'scope_key'], { unique: true });

  await q.createTable('subscription_invoices', {
    id: id(),
    institute_id: retainedInstitute(),
    subscription_id: fk('subscriptions', { allowNull: true }),
    number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    kind: { type: DataTypes.STRING(20), allowNull: false },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'open' },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: false },
    period_start: { type: DataTypes.DATE, allowNull: true },
    period_end: { type: DataTypes.DATE, allowNull: true },
    subtotal_paise: paise(),
    gst_rate_bp: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    cgst_paise: paise(),
    sgst_paise: paise(),
    igst_paise: paise(),
    total_paise: paise(),
    credited_paise: paise(),
    paid_paise: paise(),
    billed_to: { type: DataTypes.JSON, allowNull: false },
    seller: { type: DataTypes.JSON, allowNull: false },
    meta: { type: DataTypes.JSON, allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    void_reason: { type: DataTypes.STRING(255), allowNull: true },
    created_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('subscription_invoices', ['institute_id', 'status']);
  await q.addIndex('subscription_invoices', ['status', 'due_date']);
  await q.addIndex('subscription_invoices', ['issue_date']);

  await q.createTable('subscription_invoice_lines', {
    id: id(),
    invoice_id: fk('subscription_invoices'),
    description: { type: DataTypes.STRING(255), allowNull: false },
    sac_code: { type: DataTypes.STRING(10), allowNull: true },
    item_type: { type: DataTypes.STRING(30), allowNull: true },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    unit_price_paise: paise(),
    amount_paise: paise(),
    ...timestamps(),
  });

  await q.createTable('subscription_credit_notes', {
    id: id(),
    institute_id: retainedInstitute(),
    invoice_id: fk('subscription_invoices', { onDelete: 'RESTRICT' }),
    number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    taxable_paise: paise(),
    cgst_paise: paise(),
    sgst_paise: paise(),
    igst_paise: paise(),
    amount_paise: paise(),
    reason: { type: DataTypes.STRING(500), allowNull: false },
    billed_to: { type: DataTypes.JSON, allowNull: false },
    seller: { type: DataTypes.JSON, allowNull: false },
    created_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('subscription_credit_notes', ['institute_id']);

  await q.createTable('subscription_payments', {
    id: id(),
    institute_id: retainedInstitute(),
    invoice_id: fk('subscription_invoices', { allowNull: true }),
    amount_paise: paise(),
    fee_paise: paise(),
    method: { type: DataTypes.STRING(10), allowNull: false },
    gateway: { type: DataTypes.STRING(20), allowNull: true },
    gateway_order_id: { type: DataTypes.STRING(100), allowNull: true },
    gateway_payment_id: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    note: { type: DataTypes.STRING(255), allowNull: true },
    idempotency_key: { type: DataTypes.STRING(160), allowNull: true, unique: true },
    checkout_payload: { type: DataTypes.JSON, allowNull: true },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    recorded_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('subscription_payments', ['gateway', 'gateway_order_id'], { unique: true });
  await q.addIndex('subscription_payments', ['institute_id', 'created_at']);
  await q.addIndex('subscription_payments', ['status', 'paid_at']);

  await q.createTable('subscription_webhook_events', {
    id: id(),
    gateway: { type: DataTypes.STRING(20), allowNull: false },
    event_key: { type: DataTypes.STRING(191), allowNull: false },
    payment_id: fk('subscription_payments', { allowNull: true }),
    outcome: { type: DataTypes.STRING(20), allowNull: false },
    ...timestamps(),
  });
  await q.addIndex('subscription_webhook_events', ['gateway', 'event_key'], { unique: true });

  await q.createTable('subscription_addons', {
    id: id(),
    ...tenantColumns(),
    subscription_id: fk('subscriptions'),
    kind: { type: DataTypes.STRING(20), allowNull: false },
    module_key: { type: DataTypes.STRING(40), allowNull: true },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    unit_size: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    unit_price_paise: paise(),
    billing_cycle: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'monthly' },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    cancel_at_period_end: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    starts_at: { type: DataTypes.DATE, allowNull: true },
    period_month: { type: DataTypes.DATEONLY, allowNull: true },
    invoice_id: fk('subscription_invoices', { allowNull: true }),
    created_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('subscription_addons', ['institute_id', 'status']);

  await q.createTable('subscription_usage', {
    id: id(),
    ...tenantColumns(),
    snapshot_date: { type: DataTypes.DATEONLY, allowNull: false },
    students: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    branches: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    teachers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    storage_mb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    ai_tokens_month: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    limits: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('subscription_usage', ['institute_id', 'snapshot_date'], { unique: true });

  await q.createTable('subscription_settings', {
    id: id(),
    key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    value: { type: DataTypes.JSON, allowNull: false },
    updated_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.dropTable('subscription_settings');
  await q.dropTable('subscription_usage');
  await q.dropTable('subscription_addons');
  await q.dropTable('subscription_webhook_events');
  await q.dropTable('subscription_payments');
  await q.dropTable('subscription_credit_notes');
  await q.dropTable('subscription_invoice_lines');
  await q.dropTable('subscription_invoices');
  await q.dropTable('subscription_sequences');
  await q.removeIndex('subscriptions', ['status', 'ends_at']);
  for (const c of [
    'last_notice',
    'overage_billed_through',
    'trial_extended_days',
    'suspend_reason',
    'suspended_at',
    'pending_billing_cycle',
    'pending_plan_id',
    'current_period_start',
  ])
    await q.removeColumn('subscriptions', c);
  await q.removeColumn('plans', 'usage_pricing');
  await q.removeColumn('plans', 'addons');
};
