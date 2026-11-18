import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** Gateway configs provisioned from the super admin's global gateway (institute fee fallback). */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.addColumn('payment_gateway_configs', 'platform_managed', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.removeColumn('payment_gateway_configs', 'platform_managed');
};
