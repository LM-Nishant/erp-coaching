import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Seller payouts and refunds. Ledger rows (`mkt_sale_ledger`) get `payout_id` once a payout run
 * reserves them; a refund writes an `entry_type = 'refund'` row that reverses the sale.
 */
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const count = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const paise = () => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 });
const date = () => ({ type: DataTypes.DATE, allowNull: true });

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('mkt_payout_settings', {
    id: id(),
    min_payout_paise: { ...paise(), defaultValue: 50_000 },
    hold_days: { ...count(), defaultValue: 30 },
    refund_window_days: { ...count(), defaultValue: 30 },
    ...timestamps(),
  });
  await qi.bulkInsert('mkt_payout_settings', [
    {
      min_payout_paise: 50_000,
      hold_days: 30,
      refund_window_days: 30,
      created_at: new Date(),
      updated_at: new Date(),
    },
  ]);

  await qi.createTable('mkt_payout_accounts', {
    id: id(),
    seller_id: fk('mkt_sellers'),
    method: str(10),
    holder_name: str(150),
    bank_name: str(150, true),
    ifsc: str(11, true),
    // encryptSecret() output (account number or UPI id); `masked` is what screens show.
    account_encrypted: { type: DataTypes.TEXT, allowNull: false },
    masked: str(80),
    updated_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('mkt_payout_accounts', ['seller_id'], { unique: true });

  await qi.createTable('mkt_payout_runs', {
    id: id(),
    period_start: { type: DataTypes.DATE, allowNull: false },
    period_end: { type: DataTypes.DATE, allowNull: false },
    eligible_before: { type: DataTypes.DATE, allowNull: false },
    status: { ...str(20), defaultValue: 'draft' },
    created_by_user_id: fk('users', { allowNull: true }),
    finalized_at: date(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_payout_runs', ['status', 'period_end']);

  await qi.createTable('mkt_payouts', {
    id: id(),
    run_id: fk('mkt_payout_runs', { onDelete: 'RESTRICT' }),
    seller_id: fk('mkt_sellers', { onDelete: 'RESTRICT' }),
    status: { ...str(20), defaultValue: 'pending' },
    gross_paise: paise(),
    commission_paise: paise(),
    refunds_paise: paise(),
    net_paise: paise(),
    entries: count(),
    reference: str(80, true),
    paid_to_encrypted: { type: DataTypes.TEXT, allowNull: true },
    paid_to_masked: str(200, true),
    hold_reason: str(300, true),
    paid_at: date(),
    paid_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('mkt_payouts', ['run_id', 'seller_id'], { unique: true });
  await qi.addIndex('mkt_payouts', ['seller_id', 'status']);

  await qi.createTable('mkt_refunds', {
    id: id(),
    order_id: fk('mkt_orders', { onDelete: 'RESTRICT' }),
    // null = every paid item of the order
    order_item_id: fk('mkt_order_items', { allowNull: true, onDelete: 'RESTRICT' }),
    user_id: fk('users', { onDelete: 'RESTRICT' }),
    amount_paise: paise(),
    reason: str(1000),
    status: { ...str(20), defaultValue: 'requested' },
    initiated_by: str(10),
    decision_note: str(1000, true),
    decided_by_user_id: fk('users', { allowNull: true }),
    decided_at: date(),
    gateway_refund_id: str(120, true),
    ...timestamps(),
  });
  await qi.addIndex('mkt_refunds', ['status', 'created_at']);
  await qi.addIndex('mkt_refunds', ['order_id']);
  await qi.addIndex('mkt_sale_ledger', ['payout_id']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeIndex('mkt_sale_ledger', ['payout_id']);
  for (const t of [
    'mkt_refunds',
    'mkt_payouts',
    'mkt_payout_runs',
    'mkt_payout_accounts',
    'mkt_payout_settings',
  ])
    await qi.dropTable(t);
};
