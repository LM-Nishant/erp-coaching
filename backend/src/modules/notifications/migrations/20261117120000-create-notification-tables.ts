import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const json = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });
const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('notification_providers', {
    id: id(),
    ...tenantColumns(),
    channel: str(20, false),
    provider: str(30, false),
    settings: json(),
    secrets_encrypted: { type: DataTypes.TEXT, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    retry_max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    retry_base_delay_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    updated_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('notification_providers', ['institute_id', 'channel'], { unique: true });

  await q.createTable('notification_templates', {
    id: id(),
    ...tenantColumns(),
    event_key: str(80, false),
    channel: str(20, false),
    subject: str(255),
    body: { type: DataTypes.TEXT, allowNull: false },
    provider_template_id: str(120),
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await q.addIndex('notification_templates', ['institute_id', 'event_key', 'channel'], { unique: true });

  await q.createTable('notification_rules', {
    id: id(),
    ...tenantColumns(),
    event_key: str(80, false),
    channels: json(false),
    recipient_types: json(false),
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await q.addIndex('notification_rules', ['institute_id', 'event_key'], { unique: true });

  await q.createTable('notification_preferences', {
    id: id(),
    ...tenantColumns(),
    user_id: fk('users'),
    channel: str(20, false),
    // '*' = every event on the channel (channel-level consent).
    event_key: { type: DataTypes.STRING(80), allowNull: false, defaultValue: '*' },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false },
    source: str(30),
    ip: str(64),
    ...timestamps(),
  });
  await q.addIndex('notification_preferences', ['institute_id', 'user_id', 'channel', 'event_key'], {
    unique: true,
    name: 'notification_preferences_unique',
  });

  await q.createTable('notification_push_tokens', {
    id: id(),
    ...tenantColumns(),
    user_id: fk('users'),
    token: str(512, false),
    token_hash: str(64, false),
    platform: str(10, false),
    device_uid: str(120),
    last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps(),
  });
  await q.addIndex('notification_push_tokens', ['institute_id', 'token_hash'], { unique: true });
  await q.addIndex('notification_push_tokens', ['institute_id', 'user_id']);

  await q.createTable('notification_campaigns', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    title: str(150, false),
    channels: json(false),
    subject: str(255),
    body: { type: DataTypes.TEXT, allowNull: false },
    audience: json(false),
    scheduled_at: { type: DataTypes.DATE, allowNull: true },
    status: str(20, false),
    recipient_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    message_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error: { type: DataTypes.TEXT, allowNull: true },
    created_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('notification_campaigns', ['institute_id', 'status']);

  await q.createTable('notification_messages', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    event_key: str(80, false),
    channel: str(20, false),
    user_id: fk('users', { allowNull: true }),
    recipient_type: str(20),
    recipient_address: str(512),
    subject: str(255),
    body: { type: DataTypes.TEXT, allowNull: false },
    data: json(),
    status: str(20, false),
    provider: str(30),
    provider_template_id: str(120),
    provider_message_id: str(190),
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    next_attempt_at: { type: DataTypes.DATE, allowNull: true },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    campaign_id: fk('notification_campaigns', { allowNull: true }),
    sent_at: { type: DataTypes.DATE, allowNull: true },
    delivered_at: { type: DataTypes.DATE, allowNull: true },
    read_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('notification_messages', ['institute_id', 'status', 'created_at']);
  await q.addIndex('notification_messages', ['institute_id', 'user_id', 'channel', 'read_at']);
  await q.addIndex('notification_messages', ['institute_id', 'campaign_id']);
  await q.addIndex('notification_messages', ['provider', 'provider_message_id']);

  await q.createTable('notification_delivery_attempts', {
    id: id(),
    ...tenantColumns(),
    message_id: fk('notification_messages'),
    attempt_no: { type: DataTypes.INTEGER, allowNull: false },
    status: str(20, false),
    provider: str(30, false),
    provider_message_id: str(190),
    error: { type: DataTypes.TEXT, allowNull: true },
    duration_ms: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  await q.addIndex('notification_delivery_attempts', ['institute_id', 'message_id']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  for (const t of [
    'notification_delivery_attempts',
    'notification_messages',
    'notification_campaigns',
    'notification_push_tokens',
    'notification_preferences',
    'notification_rules',
    'notification_templates',
    'notification_providers',
  ]) {
    await q.dropTable(t);
  }
};
