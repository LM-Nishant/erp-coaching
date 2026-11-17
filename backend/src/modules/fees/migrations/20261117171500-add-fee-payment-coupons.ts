import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** Website coupon / referral attribution for online course purchases. */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.addColumn('fee_payments', 'coupon_code', { type: DataTypes.STRING(40), allowNull: true });
  await q.addColumn('fee_payments', 'coupon_discount', {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  });
  await q.addColumn('fee_payments', 'referral_code', { type: DataTypes.STRING(40), allowNull: true });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.removeColumn('fee_payments', 'referral_code');
  await q.removeColumn('fee_payments', 'coupon_discount');
  await q.removeColumn('fee_payments', 'coupon_code');
};
