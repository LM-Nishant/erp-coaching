import { DataTypes } from 'sequelize';
import { id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('users', {
    id: id(),
    name: { type: DataTypes.STRING(150), allowNull: false },
    mobile: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    email: { type: DataTypes.STRING(150), allowNull: true, unique: true },
    password_hash: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    is_super_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('users');
};
