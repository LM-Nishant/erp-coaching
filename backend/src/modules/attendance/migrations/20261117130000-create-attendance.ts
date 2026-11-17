import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const date = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
const status = (def: string) => ({ type: DataTypes.STRING(20), allowNull: false, defaultValue: def });
const text = () => ({ type: DataTypes.TEXT, allowNull: true });
const coord = () => ({ type: DataTypes.DECIMAL(9, 6), allowNull: true });

export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('attendance_settings', {
    id: id(),
    ...tenantColumns(),
    settings: { type: DataTypes.JSON, allowNull: false },
    ...timestamps(),
  });
  await q.addIndex('attendance_settings', ['institute_id'], { unique: true });

  await q.createTable('attendance_sessions', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    batch_id: fk('batches'),
    class_session_id: fk('class_sessions', { allowNull: true }),
    // `class:<classSessionId>` or `daily:<batchId>:<date>`: one attendance session per class/day.
    session_key: str(60, false),
    kind: status('class'),
    date: date(false),
    start_time: str(5),
    end_time: str(5),
    teacher_user_id: fk('users', { allowNull: true }),
    status: status('open'),
    qr_secret: str(64, false),
    closed_at: { type: DataTypes.DATE, allowNull: true },
    closed_by_user_id: fk('users', { allowNull: true }),
    alerts_sent_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('attendance_sessions', ['institute_id', 'session_key'], { unique: true });
  await q.addIndex('attendance_sessions', ['institute_id', 'batch_id', 'date']);
  await q.addIndex('attendance_sessions', ['institute_id', 'branch_id', 'date']);

  await q.createTable('attendance_records', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    attendance_session_id: fk('attendance_sessions'),
    batch_id: fk('batches'),
    date: date(false),
    student_user_id: fk('users'),
    status: status('present'),
    source: status('manual'),
    marked_at: { type: DataTypes.DATE, allowNull: false },
    marked_by_user_id: fk('users', { allowNull: true }),
    remarks: str(255),
    lat: coord(),
    lng: coord(),
    ...timestamps(),
  });
  await q.addIndex('attendance_records', ['attendance_session_id', 'student_user_id'], { unique: true });
  await q.addIndex('attendance_records', ['institute_id', 'student_user_id', 'date']);
  await q.addIndex('attendance_records', ['institute_id', 'batch_id', 'date']);
  await q.addIndex('attendance_records', ['institute_id', 'branch_id', 'date']);

  await q.createTable('attendance_corrections', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    attendance_session_id: fk('attendance_sessions'),
    student_user_id: fk('users'),
    requested_by_user_id: fk('users'),
    current_status: str(20),
    requested_status: str(20, false),
    reason: { type: DataTypes.TEXT, allowNull: false },
    status: status('pending'),
    decided_by_user_id: fk('users', { allowNull: true }),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    decision_note: text(),
    ...timestamps(),
  });
  await q.addIndex('attendance_corrections', ['institute_id', 'status']);
  await q.addIndex('attendance_corrections', ['institute_id', 'student_user_id']);

  await q.createTable('attendance_leave_requests', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    student_user_id: fk('users'),
    requested_by_user_id: fk('users'),
    from_date: date(false),
    to_date: date(false),
    reason: { type: DataTypes.TEXT, allowNull: false },
    status: status('pending'),
    decided_by_user_id: fk('users', { allowNull: true }),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    decision_note: text(),
    ...timestamps(),
  });
  await q.addIndex('attendance_leave_requests', ['institute_id', 'status']);
  await q.addIndex('attendance_leave_requests', ['institute_id', 'student_user_id', 'from_date']);

  await q.createTable('attendance_devices', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    name: str(100, false),
    serial: str(80, false),
    adapter: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'mock' },
    api_key_hash: str(64, false),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  // Devices authenticate pushes by serial, so serials are globally unique.
  await q.addIndex('attendance_devices', ['serial'], { unique: true });
  await q.addIndex('attendance_devices', ['institute_id']);

  await q.createTable('attendance_enrolments', {
    id: id(),
    ...tenantColumns(),
    student_user_id: fk('users'),
    enrolment_id: str(50, false),
    ...timestamps(),
  });
  await q.addIndex('attendance_enrolments', ['institute_id', 'enrolment_id'], { unique: true });
  await q.addIndex('attendance_enrolments', ['institute_id', 'student_user_id'], { unique: true });

  await q.createTable('device_events', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    device_id: fk('attendance_devices', { allowNull: true }),
    device_serial: str(80, false),
    enrolment_id: str(50, false),
    punched_at: { type: DataTypes.DATE, allowNull: false },
    direction: str(5),
    dedupe_key: str(64, false),
    status: status('applied'),
    student_user_id: fk('users', { allowNull: true }),
    attendance_record_id: fk('attendance_records', { allowNull: true }),
    note: str(255),
    ...timestamps(),
  });
  await q.addIndex('device_events', ['institute_id', 'dedupe_key'], { unique: true });
  await q.addIndex('device_events', ['institute_id', 'punched_at']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  for (const t of [
    'device_events',
    'attendance_enrolments',
    'attendance_devices',
    'attendance_leave_requests',
    'attendance_corrections',
    'attendance_records',
    'attendance_sessions',
    'attendance_settings',
  ])
    await q.dropTable(t);
};
