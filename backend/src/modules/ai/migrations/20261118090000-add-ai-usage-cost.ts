import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** Image count and estimated cost per AI call, plus optional price overrides for cost estimates. */
export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.addColumn('ai_usage', 'image_count', {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
  });
  await queryInterface.addColumn('ai_usage', 'estimated_cost_usd', {
    type: DataTypes.DECIMAL(12, 6),
    allowNull: false,
    defaultValue: 0,
  });
  await queryInterface.addColumn('ai_settings', 'input_usd_per_1m', {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true,
  });
  await queryInterface.addColumn('ai_settings', 'output_usd_per_1m', {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true,
  });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.removeColumn('ai_settings', 'output_usd_per_1m');
  await queryInterface.removeColumn('ai_settings', 'input_usd_per_1m');
  await queryInterface.removeColumn('ai_usage', 'estimated_cost_usd');
  await queryInterface.removeColumn('ai_usage', 'image_count');
};
