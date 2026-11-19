import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const json = () => ({ type: DataTypes.JSON, allowNull: true });
const ts = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });

/** ZKTeco/eSSL ADMS push devices: device settings, the users a device reports and queued commands. */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  const device = {
    // Device clock zone (IANA); null = the institute's zone.
    time_zone: str(64),
    ip_allowlist: json(),
    allow_http: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_ip: str(45),
    info: json(),
    // Upload pointers (`Stamp`) per ADMS table, echoed back at handshake.
    push_stamps: json(),
    last_error: str(255),
    last_error_at: ts(),
  };
  for (const [column, spec] of Object.entries(device)) await q.addColumn('attendance_devices', column, spec);

  await q.createTable('attendance_device_users', {
    id: id(),
    ...tenantColumns(),
    device_id: fk('attendance_devices'),
    pin: str(50, false),
    name: str(100),
    privilege: { type: DataTypes.INTEGER, allowNull: true },
    last_seen_at: ts(false),
    ...timestamps(),
  });
  await q.addIndex('attendance_device_users', ['device_id', 'pin'], { unique: true });
  await q.addIndex('attendance_device_users', ['institute_id', 'pin']);

  await q.createTable('attendance_device_commands', {
    id: id(),
    ...tenantColumns(),
    device_id: fk('attendance_devices'),
    kind: str(30, false),
    // Sent as `C:<id>:<command>`; the row id is the command id the device replies with.
    command: str(255, false),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    return_code: { type: DataTypes.INTEGER, allowNull: true },
    result: json(),
    created_by_user_id: fk('users', { allowNull: true }),
    sent_at: ts(),
    completed_at: ts(),
    ...timestamps(),
  });
  await q.addIndex('attendance_device_commands', ['device_id', 'status']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.dropTable('attendance_device_commands');
  await q.dropTable('attendance_device_users');
  for (const column of [
    'last_error_at',
    'last_error',
    'push_stamps',
    'info',
    'last_ip',
    'allow_http',
    'ip_allowlist',
    'time_zone',
  ])
    await q.removeColumn('attendance_devices', column);
};
