import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('report_exports', {
    id: id(),
    ...tenantColumns(),
    user_id: fk('users'),
    report_key: { type: DataTypes.STRING(40), allowNull: false },
    format: { type: DataTypes.STRING(8), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
    filters: { type: DataTypes.JSON, allowNull: false },
    scope: { type: DataTypes.JSON, allowNull: false },
    row_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    file_id: fk('files', { allowNull: true }),
    file_name: { type: DataTypes.STRING(200), allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('report_exports', ['institute_id', 'user_id', 'created_at']);
  await queryInterface.addIndex('report_exports', ['status', 'expires_at']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('report_exports');
};
