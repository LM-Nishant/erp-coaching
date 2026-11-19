import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

/** Media-provider webhooks (LiveKit): attendance by provider connection, event dedupe, one import per recording. */
export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.addColumn('live_participants', 'connection_ref', {
    type: DataTypes.STRING(64),
    allowNull: true,
  });

  await queryInterface.createTable('live_webhook_events', {
    id: id(),
    ...tenantColumns(),
    provider: { type: DataTypes.STRING(30), allowNull: false },
    event_id: { type: DataTypes.STRING(120), allowNull: false },
    event: { type: DataTypes.STRING(40), allowNull: false },
    live_session_id: fk('live_sessions', { allowNull: true, onDelete: 'CASCADE' }),
    ...timestamps(),
  });
  await queryInterface.addIndex('live_webhook_events', ['institute_id', 'provider', 'event_id'], {
    unique: true,
  });
  await queryInterface.addIndex('live_webhook_events', ['institute_id', 'created_at']);

  // Provider recordings may be reported twice (webhook and catch-up job); NULL refs (uploads) repeat freely.
  await queryInterface.addIndex('live_recordings', ['institute_id', 'provider_ref'], {
    unique: true,
    name: 'live_recordings_provider_ref_unique',
  });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.removeIndex('live_recordings', 'live_recordings_provider_ref_unique');
  await queryInterface.dropTable('live_webhook_events');
  await queryInterface.removeColumn('live_participants', 'connection_ref');
};
