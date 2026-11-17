import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  AppointmentEventAction,
  AppointmentMode,
  AppointmentStatus,
  SlotKind,
  SlotMode,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { Student } from '../students/models';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });

/** TIME columns come back as `HH:MM:SS`; the API speaks `HH:MM`. */
const hhmm = (field: string) => ({
  type: DataTypes.TIME,
  allowNull: false,
  get(this: Model) {
    const v = this.getDataValue(field) as string | null;
    return v ? v.slice(0, 5) : v;
  },
});

export class AppointmentSlot extends Model<
  InferAttributes<AppointmentSlot>,
  InferCreationAttributes<AppointmentSlot>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare teacherUserId: number;
  declare kind: SlotKind;
  declare dayOfWeek: number | null;
  declare date: string | null;
  declare startTime: string;
  declare endTime: string;
  declare slotMinutes: CreationOptional<number>;
  declare mode: CreationOptional<SlotMode>;
  declare location: string | null;
  declare effectiveFrom: string | null;
  declare effectiveTo: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare teacher?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    AppointmentSlot.init(
      {
        id: pk,
        instituteId: uint(false),
        branchId: uint(false),
        teacherUserId: uint(false),
        kind: str(10, false),
        dayOfWeek: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true },
        date: { type: DataTypes.DATEONLY, allowNull: true },
        startTime: hhmm('startTime'),
        endTime: hhmm('endTime'),
        slotMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 15 },
        mode: { ...str(10, false), defaultValue: 'both' },
        location: str(200),
        effectiveFrom: { type: DataTypes.DATEONLY, allowNull: true },
        effectiveTo: { type: DataTypes.DATEONLY, allowNull: true },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'appointment_slots' },
    );
    registerTenantModel(AppointmentSlot);
  }
}

export class Appointment extends Model<InferAttributes<Appointment>, InferCreationAttributes<Appointment>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare slotId: number | null;
  declare teacherUserId: number;
  declare requestedByUserId: number;
  declare studentId: number;
  declare studentUserId: number | null;
  declare date: string;
  declare startTime: string;
  declare endTime: string;
  declare mode: AppointmentMode;
  declare status: CreationOptional<AppointmentStatus>;
  declare agenda: string | null;
  declare location: CreationOptional<string | null>;
  declare meetingUrl: CreationOptional<string | null>;
  declare calendarProvider: CreationOptional<string | null>;
  declare calendarEventId: CreationOptional<string | null>;
  declare responseNote: CreationOptional<string | null>;
  declare cancelReason: CreationOptional<string | null>;
  declare cancelledByUserId: CreationOptional<number | null>;
  declare rescheduleCount: CreationOptional<number>;
  declare respondedAt: CreationOptional<Date | null>;
  declare privateNotes: CreationOptional<string | null>;
  declare sharedSummary: CreationOptional<string | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare lastReminderKey: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare teacher?: NonAttribute<User | null>;
  declare requestedBy?: NonAttribute<User | null>;
  declare student?: NonAttribute<Student | null>;
  declare events?: NonAttribute<AppointmentEvent[]>;

  static initModel(sequelize: Sequelize) {
    Appointment.init(
      {
        id: pk,
        instituteId: uint(false),
        branchId: uint(false),
        slotId: uint(),
        teacherUserId: uint(false),
        requestedByUserId: uint(false),
        studentId: uint(false),
        studentUserId: uint(),
        date: { type: DataTypes.DATEONLY, allowNull: false },
        startTime: hhmm('startTime'),
        endTime: hhmm('endTime'),
        mode: str(10, false),
        status: { ...str(12, false), defaultValue: 'requested' },
        agenda: str(1000),
        location: str(200),
        meetingUrl: str(500),
        calendarProvider: str(20),
        calendarEventId: str(200),
        responseNote: str(1000),
        cancelReason: str(1000),
        cancelledByUserId: uint(),
        rescheduleCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        respondedAt: { type: DataTypes.DATE, allowNull: true },
        privateNotes: { type: DataTypes.TEXT, allowNull: true },
        sharedSummary: { type: DataTypes.TEXT, allowNull: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },
        lastReminderKey: str(60),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'appointments' },
    );
    registerTenantModel(Appointment);
  }
}

export class AppointmentEvent extends Model<
  InferAttributes<AppointmentEvent>,
  InferCreationAttributes<AppointmentEvent>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare appointmentId: number;
  declare actorUserId: number | null;
  declare action: AppointmentEventAction;
  declare fromStatus: AppointmentStatus | null;
  declare toStatus: AppointmentStatus | null;
  declare note: string | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare actor?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    AppointmentEvent.init(
      {
        id: pk,
        instituteId: uint(false),
        appointmentId: uint(false),
        actorUserId: uint(),
        action: str(20, false),
        fromStatus: str(12),
        toStatus: str(12),
        note: str(1000),
        metadata: { type: DataTypes.JSON, allowNull: true },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'appointment_events' },
    );
    registerTenantModel(AppointmentEvent);
  }
}

export function initAppointmentModels(sequelize: Sequelize) {
  AppointmentSlot.initModel(sequelize);
  Appointment.initModel(sequelize);
  AppointmentEvent.initModel(sequelize);
}

export function associateAppointmentModels() {
  AppointmentSlot.belongsTo(User, { as: 'teacher', foreignKey: 'teacherUserId' });
  Appointment.belongsTo(User, { as: 'teacher', foreignKey: 'teacherUserId' });
  Appointment.belongsTo(User, { as: 'requestedBy', foreignKey: 'requestedByUserId' });
  Appointment.belongsTo(Student, { as: 'student', foreignKey: 'studentId' });
  Appointment.hasMany(AppointmentEvent, { as: 'events', foreignKey: 'appointmentId' });
  AppointmentEvent.belongsTo(User, { as: 'actor', foreignKey: 'actorUserId' });
}
