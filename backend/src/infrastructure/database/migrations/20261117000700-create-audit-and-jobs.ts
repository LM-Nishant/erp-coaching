import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('audit_events', {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    institute_id: fk('institutes', { allowNull: true, onDelete: 'CASCADE' }),
    actor_user_id: fk('users', { allowNull: true }),
    impersonator_user_id: fk('users', { allowNull: true }),
    action: { type: DataTypes.STRING(100), allowNull: false },
    entity_type: { type: DataTypes.STRING(60), allowNull: true },
    entity_id: { type: DataTypes.STRING(64), allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  await queryInterface.addIndex('audit_events', ['institute_id', 'created_at']);
  await queryInterface.addIndex('audit_events', ['entity_type', 'entity_id']);

  await queryInterface.createTable('jobs', {
    id: id(),
    name: { type: DataTypes.STRING(120), allowNull: false },
    institute_id: fk('institutes', { allowNull: true, onDelete: 'CASCADE' }),
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
    run_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    locked_at: { type: DataTypes.DATE, allowNull: true },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('jobs', ['status', 'run_at']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('jobs');
  await queryInterface.dropTable('audit_events');
};
