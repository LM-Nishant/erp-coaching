import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Vendor delivery webhooks: an unguessable key per institute provider identifies the provider in the
 * public webhook URL. Template parameters keep the rendered `{{ }}` values of a message so vendor
 * templates (DLT, WhatsApp) receive them positionally on every retry.
 */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.addColumn('notification_providers', 'webhook_key', {
    type: DataTypes.STRING(64),
    allowNull: true,
  });
  await q.addIndex('notification_providers', ['webhook_key'], {
    unique: true,
    name: 'notification_providers_webhook_key',
  });
  await q.addColumn('notification_messages', 'template_params', { type: DataTypes.JSON, allowNull: true });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.removeColumn('notification_messages', 'template_params');
  await q.removeIndex('notification_providers', 'notification_providers_webhook_key');
  await q.removeColumn('notification_providers', 'webhook_key');
};
