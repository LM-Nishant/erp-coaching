import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('calendar_connections', {
    id: id(),
    ...tenantColumns(),
    user_id: fk('users', { allowNull: true, onDelete: 'CASCADE' }),
    owner_key: { type: DataTypes.STRING(40), allowNull: false },
    provider: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'google' },
    account_id: { type: DataTypes.STRING(255), allowNull: false },
    account_email: { type: DataTypes.STRING(255), allowNull: true },
    scopes: { type: DataTypes.STRING(1000), allowNull: true },
    refresh_token_encrypted: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
    connected_by_user_id: fk('users', { allowNull: true }),
    connected_at: { type: DataTypes.DATE, allowNull: false },
    last_checked_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('calendar_connections', ['institute_id', 'owner_key'], { unique: true });
  await queryInterface.addIndex('calendar_connections', ['account_id']);

  await queryInterface.createTable('calendar_oauth_states', {
    id: id(),
    ...tenantColumns(),
    user_id: fk('users'),
    owner_user_id: fk('users', { allowNull: true, onDelete: 'CASCADE' }),
    state_hash: { type: DataTypes.CHAR(64), allowNull: false },
    nonce_hash: { type: DataTypes.CHAR(64), allowNull: true },
    code_verifier_encrypted: { type: DataTypes.TEXT, allowNull: true },
    client: { type: DataTypes.STRING(10), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    started_at: { type: DataTypes.DATE, allowNull: true },
    used_at: { type: DataTypes.DATE, allowNull: true },
    result: { type: DataTypes.STRING(20), allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('calendar_oauth_states', ['state_hash'], { unique: true });
  await queryInterface.addIndex('calendar_oauth_states', ['institute_id', 'expires_at']);

  await queryInterface.createTable('calendar_events', {
    id: id(),
    ...tenantColumns(),
    source: { type: DataTypes.STRING(40), allowNull: false },
    source_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    connection_id: fk('calendar_connections', { allowNull: true }),
    provider: { type: DataTypes.STRING(20), allowNull: false },
    account_id: { type: DataTypes.STRING(255), allowNull: true },
    event_id: { type: DataTypes.STRING(255), allowNull: true },
    generation: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    meeting_url: { type: DataTypes.STRING(500), allowNull: true },
    content_hash: { type: DataTypes.CHAR(64), allowNull: true },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    last_error: { type: DataTypes.STRING(500), allowNull: true },
    synced_at: { type: DataTypes.DATE, allowNull: true },
    locked_until: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('calendar_events', ['institute_id', 'source', 'source_id'], { unique: true });
  await queryInterface.addIndex('calendar_events', ['institute_id', 'connection_id', 'status']);
  await queryInterface.addIndex('calendar_events', ['account_id', 'status']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('calendar_events');
  await queryInterface.dropTable('calendar_oauth_states');
  await queryInterface.dropTable('calendar_connections');
};
