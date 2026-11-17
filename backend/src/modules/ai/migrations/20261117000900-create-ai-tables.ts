import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('ai_settings', {
    id: id(),
    scope: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    provider: { type: DataTypes.STRING(30), allowNull: false },
    base_url: { type: DataTypes.STRING(500), allowNull: false },
    model: { type: DataTypes.STRING(150), allowNull: false },
    api_key_encrypted: { type: DataTypes.TEXT, allowNull: true },
    json_mode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    updated_by: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.createTable('ai_usage', {
    id: id(),
    // Nullable: platform-level calls (e.g. connection tests) are not billed to a tenant.
    institute_id: fk('institutes', { allowNull: true, onDelete: 'CASCADE' }),
    user_id: fk('users', { allowNull: true }),
    feature: { type: DataTypes.STRING(80), allowNull: false },
    provider: { type: DataTypes.STRING(30), allowNull: false },
    model: { type: DataTypes.STRING(150), allowNull: false },
    prompt_tokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    completion_tokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    total_tokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(10), allowNull: false },
    latency_ms: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  await queryInterface.addIndex('ai_usage', ['institute_id', 'created_at']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('ai_usage');
  await queryInterface.dropTable('ai_settings');
};
