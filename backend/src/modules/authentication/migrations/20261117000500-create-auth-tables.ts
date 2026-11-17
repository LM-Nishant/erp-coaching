import { DataTypes } from 'sequelize';
import { id, timestamps, fk, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('devices', {
    id: id(),
    user_id: fk('users'),
    device_uid: { type: DataTypes.STRING(128), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: true },
    platform: { type: DataTypes.STRING(20), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    last_ip: { type: DataTypes.STRING(64), allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    revoked_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('devices', ['user_id', 'device_uid'], { unique: true });

  await queryInterface.createTable('otp_challenges', {
    id: { type: DataTypes.STRING(36), primaryKey: true },
    user_id: fk('users', { allowNull: true, onDelete: 'CASCADE' }),
    mobile: { type: DataTypes.STRING(20), allowNull: false },
    purpose: { type: DataTypes.STRING(20), allowNull: false },
    code_hash: { type: DataTypes.STRING(64), allowNull: false },
    device_uid: { type: DataTypes.STRING(128), allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    consumed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('otp_challenges', ['mobile', 'created_at']);

  await queryInterface.createTable('refresh_tokens', {
    id: id(),
    user_id: fk('users'),
    device_id: fk('devices'),
    institute_id: fk('institutes', { allowNull: true, onDelete: 'CASCADE' }),
    token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });

  await queryInterface.createTable('impersonation_sessions', {
    id: id(),
    super_admin_id: fk('users'),
    target_user_id: fk('users'),
    institute_id: fk('institutes'),
    reason: { type: DataTypes.STRING(255), allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    ended_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  for (const t of ['impersonation_sessions', 'refresh_tokens', 'otp_challenges', 'devices']) {
    await queryInterface.dropTable(t);
  }
};
