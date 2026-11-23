import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Personal (platform-level) inbox for users who belong to no institute, e.g. marketplace-only learners and
 * independent instructors. Not tenant tables: rows belong to the user, not to an institute.
 */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('notification_platform_messages', {
    id: id(),
    user_id: fk('users'),
    event_key: { type: DataTypes.STRING(80), allowNull: false },
    subject: { type: DataTypes.STRING(255), allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: false },
    data: { type: DataTypes.JSON, allowNull: true },
    read_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('notification_platform_messages', ['user_id', 'read_at']);

  await q.createTable('notification_platform_push_tokens', {
    id: id(),
    user_id: fk('users'),
    token: { type: DataTypes.STRING(512), allowNull: false },
    token_hash: { type: DataTypes.STRING(64), allowNull: false },
    platform: { type: DataTypes.STRING(10), allowNull: false },
    device_uid: { type: DataTypes.STRING(120), allowNull: true },
    last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps(),
  });
  await q.addIndex('notification_platform_push_tokens', ['token_hash'], { unique: true });
  await q.addIndex('notification_platform_push_tokens', ['user_id']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.dropTable('notification_platform_push_tokens');
  await q.dropTable('notification_platform_messages');
};
