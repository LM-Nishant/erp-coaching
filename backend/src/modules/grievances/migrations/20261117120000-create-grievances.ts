import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('grievance_settings', {
    id: id(),
    ...tenantColumns(),
    ticket_prefix: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'GRV' },
    default_sla_hours: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 72 },
    escalation_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await queryInterface.addIndex('grievance_settings', ['institute_id'], { unique: true });

  await queryInterface.createTable('grievance_counters', {
    id: id(),
    ...tenantColumns(),
    year: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    last_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await queryInterface.addIndex('grievance_counters', ['institute_id', 'year'], { unique: true });

  await queryInterface.createTable('grievance_categories', {
    id: id(),
    ...tenantColumns(),
    name: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true },
    default_assignee_user_id: fk('users', { allowNull: true }),
    sla_hours: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 72 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('grievance_categories', ['institute_id', 'name'], { unique: true });

  await queryInterface.createTable('grievance_tickets', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    ticket_number: { type: DataTypes.STRING(30), allowNull: false },
    category_id: { ...fk('grievance_categories'), onDelete: 'RESTRICT' },
    subject: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'medium' },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
    requester_type: { type: DataTypes.STRING(10), allowNull: false },
    requester_user_id: { ...fk('users'), onDelete: 'RESTRICT' },
    on_behalf_of_user_id: fk('users', { allowNull: true }),
    assignee_user_id: fk('users', { allowNull: true }),
    due_at: { type: DataTypes.DATE, allowNull: true },
    first_response_at: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    escalated_at: { type: DataTypes.DATE, allowNull: true },
    escalation_level: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    sla_breached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    reopen_count: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    resolution_notes: { type: DataTypes.TEXT, allowNull: true },
    closure_confirmed: { type: DataTypes.BOOLEAN, allowNull: true },
    satisfaction_rating: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },
    closure_feedback: { type: DataTypes.STRING(1000), allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('grievance_tickets', ['institute_id', 'ticket_number'], { unique: true });
  await queryInterface.addIndex('grievance_tickets', ['institute_id', 'status', 'due_at']);
  await queryInterface.addIndex('grievance_tickets', ['institute_id', 'requester_user_id']);
  await queryInterface.addIndex('grievance_tickets', ['institute_id', 'assignee_user_id']);
  await queryInterface.addIndex('grievance_tickets', ['institute_id', 'created_at']);

  await queryInterface.createTable('grievance_activities', {
    id: id(),
    ...tenantColumns(),
    ticket_id: fk('grievance_tickets'),
    author_user_id: fk('users', { allowNull: true }),
    type: { type: DataTypes.STRING(20), allowNull: false },
    is_internal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    body: { type: DataTypes.TEXT, allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('grievance_activities', ['institute_id', 'ticket_id']);

  await queryInterface.createTable('grievance_attachments', {
    id: id(),
    ...tenantColumns(),
    ticket_id: fk('grievance_tickets'),
    activity_id: fk('grievance_activities', { allowNull: true }),
    file_id: fk('files'),
    uploaded_by_user_id: fk('users', { allowNull: true }),
    is_internal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps(),
  });
  await queryInterface.addIndex('grievance_attachments', ['institute_id', 'ticket_id']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('grievance_attachments');
  await queryInterface.dropTable('grievance_activities');
  await queryInterface.dropTable('grievance_tickets');
  await queryInterface.dropTable('grievance_categories');
  await queryInterface.dropTable('grievance_counters');
  await queryInterface.dropTable('grievance_settings');
};
