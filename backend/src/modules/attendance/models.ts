import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type InitOptions,
  type ModelAttributes,
  type ModelStatic,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  AttendanceRecordSource,
  AttendanceRequestStatus,
  AttendanceSessionKind,
  AttendanceSessionStatus,
  AttendanceSettingsDto,
  AttendanceStatus,
  DeviceEventStatus,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { Batch, ClassSession } from '../academics/api';

type Ts = { createdAt: CreationOptional<Date>; updatedAt: CreationOptional<Date> };

export class AttendanceSettings extends Model<
  InferAttributes<AttendanceSettings>,
  InferCreationAttributes<AttendanceSettings>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare settings: Partial<AttendanceSettingsDto>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class AttendanceSession extends Model<
  InferAttributes<AttendanceSession>,
  InferCreationAttributes<AttendanceSession>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare batchId: number;
  declare classSessionId: number | null;
  declare sessionKey: string;
  declare kind: AttendanceSessionKind;
  declare date: string;
  declare startTime: string | null;
  declare endTime: string | null;
  declare teacherUserId: number | null;
  declare status: CreationOptional<AttendanceSessionStatus>;
  declare qrSecret: string;
  declare closedAt: CreationOptional<Date | null>;
  declare closedByUserId: CreationOptional<number | null>;
  declare alertsSentAt: CreationOptional<Date | null>;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
  declare batch?: NonAttribute<Batch>;
  declare classSession?: NonAttribute<ClassSession | null>;
}

export class AttendanceRecord extends Model<
  InferAttributes<AttendanceRecord>,
  InferCreationAttributes<AttendanceRecord>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare attendanceSessionId: number;
  declare batchId: number;
  declare date: string;
  declare studentUserId: number;
  declare status: AttendanceStatus;
  declare source: AttendanceRecordSource;
  declare markedAt: Date;
  declare markedByUserId: number | null;
  declare remarks: CreationOptional<string | null>;
  declare lat: CreationOptional<number | null>;
  declare lng: CreationOptional<number | null>;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
  declare session?: NonAttribute<AttendanceSession>;
  declare student?: NonAttribute<User>;
}

export class AttendanceCorrection extends Model<
  InferAttributes<AttendanceCorrection>,
  InferCreationAttributes<AttendanceCorrection>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare attendanceSessionId: number;
  declare studentUserId: number;
  declare requestedByUserId: number;
  declare currentStatus: AttendanceStatus | null;
  declare requestedStatus: AttendanceStatus;
  declare reason: string;
  declare status: CreationOptional<AttendanceRequestStatus>;
  declare decidedByUserId: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare decisionNote: CreationOptional<string | null>;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
  declare session?: NonAttribute<AttendanceSession>;
  declare student?: NonAttribute<User>;
}

export class StudentLeaveRequest extends Model<
  InferAttributes<StudentLeaveRequest>,
  InferCreationAttributes<StudentLeaveRequest>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare studentUserId: number;
  declare requestedByUserId: number;
  declare fromDate: string;
  declare toDate: string;
  declare reason: string;
  declare status: CreationOptional<AttendanceRequestStatus>;
  declare decidedByUserId: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare decisionNote: CreationOptional<string | null>;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
  declare student?: NonAttribute<User>;
}

export class AttendanceDevice extends Model<
  InferAttributes<AttendanceDevice>,
  InferCreationAttributes<AttendanceDevice>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare name: string;
  declare serial: string;
  declare adapter: CreationOptional<string>;
  declare apiKeyHash: string;
  declare active: CreationOptional<boolean>;
  declare lastSeenAt: CreationOptional<Date | null>;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
}

export class AttendanceEnrolment extends Model<
  InferAttributes<AttendanceEnrolment>,
  InferCreationAttributes<AttendanceEnrolment>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentUserId: number;
  declare enrolmentId: string;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
  declare student?: NonAttribute<User>;
}

export class DeviceEvent extends Model<InferAttributes<DeviceEvent>, InferCreationAttributes<DeviceEvent>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare deviceId: number | null;
  declare deviceSerial: string;
  declare enrolmentId: string;
  declare punchedAt: Date;
  declare direction: string | null;
  declare dedupeKey: string;
  declare status: DeviceEventStatus;
  declare studentUserId: number | null;
  declare attendanceRecordId: number | null;
  declare note: string | null;
  declare createdAt: Ts['createdAt'];
  declare updatedAt: Ts['updatedAt'];
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const dateOnly = () => ({ type: DataTypes.DATEONLY, allowNull: false });
const ts = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });
/** DECIMAL comes back as a string from mysql2. */
const coord = (field: string) => ({
  type: DataTypes.DECIMAL(9, 6),
  allowNull: true,
  get(this: Model) {
    const v = this.getDataValue(field) as string | null;
    return v == null ? null : Number(v);
  },
});
// Fresh attribute objects per model: Sequelize mutates them (field names) during init.
const base = () => ({
  id: { ...pk },
  instituteId: uint(false),
  createdAt: DataTypes.DATE,
  updatedAt: DataTypes.DATE,
});

function define<M extends Model>(
  model: ModelStatic<M>,
  sequelize: Sequelize,
  tableName: string,
  attrs: Record<string, unknown>,
) {
  (model as unknown as { init: (a: ModelAttributes, o: InitOptions) => void }).init(
    { ...base(), ...attrs } as ModelAttributes,
    { sequelize, tableName },
  );
  registerTenantModel(model);
}

const request = () => ({
  branchId: uint(false),
  studentUserId: uint(false),
  requestedByUserId: uint(false),
  reason: { type: DataTypes.TEXT, allowNull: false },
  status: { ...str(20), defaultValue: 'pending' },
  decidedByUserId: uint(),
  decidedAt: ts(),
  decisionNote: { type: DataTypes.TEXT, allowNull: true },
});

export function initAttendanceModels(sequelize: Sequelize) {
  define(AttendanceSettings, sequelize, 'attendance_settings', {
    settings: { type: DataTypes.JSON, allowNull: false },
  });
  define(AttendanceSession, sequelize, 'attendance_sessions', {
    branchId: uint(false),
    batchId: uint(false),
    classSessionId: uint(),
    sessionKey: str(60),
    kind: str(20),
    date: dateOnly(),
    startTime: str(5, true),
    endTime: str(5, true),
    teacherUserId: uint(),
    status: { ...str(20), defaultValue: 'open' },
    qrSecret: str(64),
    closedAt: ts(),
    closedByUserId: uint(),
    alertsSentAt: ts(),
  });
  define(AttendanceRecord, sequelize, 'attendance_records', {
    branchId: uint(false),
    attendanceSessionId: uint(false),
    batchId: uint(false),
    date: dateOnly(),
    studentUserId: uint(false),
    status: str(20),
    source: str(20),
    markedAt: ts(false),
    markedByUserId: uint(),
    remarks: str(255, true),
    lat: coord('lat'),
    lng: coord('lng'),
  });
  define(AttendanceCorrection, sequelize, 'attendance_corrections', {
    ...request(),
    attendanceSessionId: uint(false),
    currentStatus: str(20, true),
    requestedStatus: str(20),
  });
  define(StudentLeaveRequest, sequelize, 'attendance_leave_requests', {
    ...request(),
    fromDate: dateOnly(),
    toDate: dateOnly(),
  });
  define(AttendanceDevice, sequelize, 'attendance_devices', {
    branchId: uint(),
    name: str(100),
    serial: str(80),
    adapter: { ...str(30), defaultValue: 'mock' },
    apiKeyHash: str(64),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastSeenAt: ts(),
  });
  define(AttendanceEnrolment, sequelize, 'attendance_enrolments', {
    studentUserId: uint(false),
    enrolmentId: str(50),
  });
  define(DeviceEvent, sequelize, 'device_events', {
    branchId: uint(),
    deviceId: uint(),
    deviceSerial: str(80),
    enrolmentId: str(50),
    punchedAt: ts(false),
    direction: str(5, true),
    dedupeKey: str(64),
    status: { ...str(20), defaultValue: 'applied' },
    studentUserId: uint(),
    attendanceRecordId: uint(),
    note: str(255, true),
  });
}

export function associateAttendanceModels() {
  AttendanceSession.belongsTo(Batch, { as: 'batch', foreignKey: 'batchId' });
  AttendanceSession.belongsTo(ClassSession, { as: 'classSession', foreignKey: 'classSessionId' });
  AttendanceRecord.belongsTo(AttendanceSession, { as: 'session', foreignKey: 'attendanceSessionId' });
  AttendanceRecord.belongsTo(User, { as: 'student', foreignKey: 'studentUserId' });
  AttendanceCorrection.belongsTo(AttendanceSession, { as: 'session', foreignKey: 'attendanceSessionId' });
  AttendanceCorrection.belongsTo(User, { as: 'student', foreignKey: 'studentUserId' });
  StudentLeaveRequest.belongsTo(User, { as: 'student', foreignKey: 'studentUserId' });
  AttendanceEnrolment.belongsTo(User, { as: 'student', foreignKey: 'studentUserId' });
}
