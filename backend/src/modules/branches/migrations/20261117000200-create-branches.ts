import { DataTypes } from 'sequelize';
import { id, timestamps, tenantColumns, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('branches', {
    id: id(),
    ...tenantColumns(),
    name: { type: DataTypes.STRING(150), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    address: { type: DataTypes.TEXT, allowNull: true },
    city: { type: DataTypes.STRING(80), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    email: { type: DataTypes.STRING(150), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    ...timestamps(),
  });
  await queryInterface.addIndex('branches', ['institute_id', 'code'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('branches');
};
