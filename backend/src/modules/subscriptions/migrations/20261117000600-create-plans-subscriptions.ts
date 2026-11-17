import { DataTypes } from 'sequelize';
import { id, timestamps, fk, tenantColumns, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('plans', {
    id: id(),
    code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    price_monthly_paise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    price_yearly_paise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    trial_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 14 },
    limits: { type: DataTypes.JSON, allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await queryInterface.createTable('subscriptions', {
    id: id(),
    ...tenantColumns(),
    plan_id: fk('plans', { onDelete: 'RESTRICT' }),
    status: { type: DataTypes.STRING(20), allowNull: false },
    billing_cycle: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'monthly' },
    starts_at: { type: DataTypes.DATE, allowNull: false },
    ends_at: { type: DataTypes.DATE, allowNull: true },
    limit_overrides: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('subscriptions', ['institute_id', 'status']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('subscriptions');
  await queryInterface.dropTable('plans');
};
