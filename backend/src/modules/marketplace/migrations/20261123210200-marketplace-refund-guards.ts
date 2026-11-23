import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * One refund per order item: `mkt_order_items.refund_id` is claimed (conditional update) by the refund
 * that covers the item before the gateway is called, so a second refund of the same item can't start.
 * `mkt_refunds.gateway_payment_id` marks the refund of an extra payment of an order (paid twice), which
 * returns that payment only; at most one refund per payment.
 */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('mkt_order_items', 'refund_id', {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
  });
  await qi.addIndex('mkt_order_items', ['refund_id']);
  await qi.addColumn('mkt_refunds', 'gateway_payment_id', { type: DataTypes.STRING(120), allowNull: true });
  await qi.addIndex('mkt_refunds', ['gateway_payment_id'], { unique: true });

  // Refunded items keep the refund that reversed them; failed refunds keep their items for a retry.
  await qi.sequelize.query(
    `UPDATE mkt_order_items i
       JOIN mkt_refunds r ON r.order_id = i.order_id AND (r.order_item_id = i.id OR r.order_item_id IS NULL)
        SET i.refund_id = r.id
      WHERE i.refund_id IS NULL AND r.status = 'refunded'
        AND EXISTS (SELECT 1 FROM mkt_sale_ledger l WHERE l.order_item_id = i.id AND l.entry_type = 'refund')`,
  );
  await qi.sequelize.query(
    `UPDATE mkt_order_items i
       JOIN mkt_refunds r ON r.order_id = i.order_id AND (r.order_item_id = i.id OR r.order_item_id IS NULL)
        SET i.refund_id = r.id
      WHERE i.refund_id IS NULL AND r.status = 'failed' AND i.paid_paise > 0`,
  );
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeIndex('mkt_refunds', ['gateway_payment_id']);
  await qi.removeColumn('mkt_refunds', 'gateway_payment_id');
  await qi.removeIndex('mkt_order_items', ['refund_id']);
  await qi.removeColumn('mkt_order_items', 'refund_id');
};
