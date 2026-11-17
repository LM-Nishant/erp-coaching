import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('files', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    owner_user_id: fk('users', { allowNull: true }),
    module: { type: DataTypes.STRING(60), allowNull: false },
    storage_driver: { type: DataTypes.STRING(10), allowNull: false },
    storage_key: { type: DataTypes.STRING(500), allowNull: false },
    original_name: { type: DataTypes.STRING(255), allowNull: false },
    mime_type: { type: DataTypes.STRING(150), allowNull: false },
    size_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    checksum_sha256: { type: DataTypes.STRING(64), allowNull: true },
    visibility: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'private' },
    ...timestamps(),
  });
  await queryInterface.addIndex('files', ['institute_id', 'module']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('files');
};
