import { DataTypes } from 'sequelize';
import { id, timestamps, fk, type Migration } from '../../../infrastructure/database/migration-helpers';

/** Super admin global integrations: SaaS payment gateways, default notification providers, storage. */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('platform_integrations', {
    id: id(),
    kind: { type: DataTypes.STRING(20), allowNull: false },
    slot: { type: DataTypes.STRING(40), allowNull: false },
    provider: { type: DataTypes.STRING(40), allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    settings: { type: DataTypes.JSON, allowNull: false },
    secrets_encrypted: { type: DataTypes.TEXT, allowNull: true },
    tested_fingerprint: { type: DataTypes.STRING(64), allowNull: true },
    last_test_ok: { type: DataTypes.BOOLEAN, allowNull: true },
    last_tested_at: { type: DataTypes.DATE, allowNull: true },
    last_test_message: { type: DataTypes.STRING(500), allowNull: true },
    updated_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await q.addIndex('platform_integrations', ['kind', 'slot'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.dropTable('platform_integrations');
};
