import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('appointment_slots', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    teacher_user_id: fk('users'),
    kind: { type: DataTypes.STRING(10), allowNull: false },
    day_of_week: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: true },
    start_time: { type: DataTypes.TIME, allowNull: false },
    end_time: { type: DataTypes.TIME, allowNull: false },
    slot_minutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 15 },
    mode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'both' },
    location: { type: DataTypes.STRING(200), allowNull: true },
    effective_from: { type: DataTypes.DATEONLY, allowNull: true },
    effective_to: { type: DataTypes.DATEONLY, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('appointment_slots', ['institute_id', 'teacher_user_id', 'is_active']);
  await queryInterface.addIndex('appointment_slots', ['institute_id', 'branch_id']);

  await queryInterface.createTable('appointments', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    slot_id: fk('appointment_slots', { allowNull: true }),
    teacher_user_id: { ...fk('users'), onDelete: 'RESTRICT' },
    requested_by_user_id: { ...fk('users'), onDelete: 'RESTRICT' },
    student_id: fk('students'),
    student_user_id: fk('users', { allowNull: true }),
    date: { type: DataTypes.DATEONLY, allowNull: false },
    start_time: { type: DataTypes.TIME, allowNull: false },
    end_time: { type: DataTypes.TIME, allowNull: false },
    mode: { type: DataTypes.STRING(10), allowNull: false },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'requested' },
    agenda: { type: DataTypes.STRING(1000), allowNull: true },
    location: { type: DataTypes.STRING(200), allowNull: true },
    meeting_url: { type: DataTypes.STRING(500), allowNull: true },
    calendar_provider: { type: DataTypes.STRING(20), allowNull: true },
    calendar_event_id: { type: DataTypes.STRING(200), allowNull: true },
    response_note: { type: DataTypes.STRING(1000), allowNull: true },
    cancel_reason: { type: DataTypes.STRING(1000), allowNull: true },
    cancelled_by_user_id: fk('users', { allowNull: true }),
    reschedule_count: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    responded_at: { type: DataTypes.DATE, allowNull: true },
    private_notes: { type: DataTypes.TEXT, allowNull: true },
    shared_summary: { type: DataTypes.TEXT, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    last_reminder_key: { type: DataTypes.STRING(60), allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('appointments', ['institute_id', 'teacher_user_id', 'date']);
  await queryInterface.addIndex('appointments', ['institute_id', 'student_id']);
  await queryInterface.addIndex('appointments', ['institute_id', 'requested_by_user_id']);
  await queryInterface.addIndex('appointments', ['institute_id', 'branch_id', 'date']);
  await queryInterface.addIndex('appointments', ['institute_id', 'status', 'date']);

  await queryInterface.createTable('appointment_events', {
    id: id(),
    ...tenantColumns(),
    appointment_id: fk('appointments'),
    actor_user_id: fk('users', { allowNull: true }),
    action: { type: DataTypes.STRING(20), allowNull: false },
    from_status: { type: DataTypes.STRING(12), allowNull: true },
    to_status: { type: DataTypes.STRING(12), allowNull: true },
    note: { type: DataTypes.STRING(1000), allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('appointment_events', ['institute_id', 'appointment_id']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('appointment_events');
  await queryInterface.dropTable('appointments');
  await queryInterface.dropTable('appointment_slots');
};
