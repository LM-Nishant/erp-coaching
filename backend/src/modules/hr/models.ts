import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type ModelAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  AssetStatus,
  ContractStatus,
  EmployeeStatus,
  EmploymentType,
  LeaveStatus,
  SeparationStatus,
  SeparationType,
  StaffAttendanceStatus,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { FileObject } from '../files/file.model';
import { Branch } from '../branches/branch.model';

const PK = () => ({ type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true });
const FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false });
const OPT_FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
const TS = () => ({ createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE });
/** DECIMAL columns come back from mysql2 as strings; expose them as numbers. */
const decimal = (name: string, allowNull = false) => ({
  type: DataTypes.DECIMAL(5, 1),
  allowNull,
  get(this: Model) {
    const v = this.getDataValue(name);
    return v == null ? null : Number(v);
  },
});

type AnyModelStatic = {
  init: (attrs: ModelAttributes, opts: { sequelize: Sequelize; tableName: string }) => unknown;
};

function init(model: unknown, sequelize: Sequelize, tableName: string, attrs: ModelAttributes) {
  (model as AnyModelStatic).init(
    { id: PK(), instituteId: FK(), ...attrs, ...TS() },
    { sequelize, tableName },
  );
  registerTenantModel(model as never);
}

type Base = { id: CreationOptional<number>; instituteId: number };

export class Shift extends Model<InferAttributes<Shift>, InferCreationAttributes<Shift>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare name: string;
  declare startTime: string;
  declare endTime: string;
  declare graceMinutes: CreationOptional<number>;
  /** 0 = Sunday … 6 = Saturday. */
  declare weeklyOffs: number[] | null;
  declare active: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Employee extends Model<InferAttributes<Employee>, InferCreationAttributes<Employee>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare userId: number | null;
  declare employeeCode: string;
  declare name: string;
  declare email: string | null;
  declare mobile: string | null;
  declare designation: string | null;
  declare department: string | null;
  declare employmentType: CreationOptional<EmploymentType>;
  declare isTeacher: CreationOptional<boolean>;
  declare dateOfJoining: string;
  declare dateOfBirth: string | null;
  declare dateOfExit: string | null;
  declare gender: string | null;
  declare address: string | null;
  declare pan: string | null;
  declare uan: string | null;
  declare esiNumber: string | null;
  declare bankAccountName: string | null;
  declare bankAccountNumber: string | null;
  declare bankIfsc: string | null;
  declare shiftId: number | null;
  declare biometricEnrolmentId: string | null;
  declare status: CreationOptional<EmployeeStatus>;
  declare notes: string | null;
  declare shift?: NonAttribute<Shift | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmployeeQualification extends Model<
  InferAttributes<EmployeeQualification>,
  InferCreationAttributes<EmployeeQualification>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare degree: string;
  declare institution: string | null;
  declare yearOfPassing: number | null;
  declare grade: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmployeeExperience extends Model<
  InferAttributes<EmployeeExperience>,
  InferCreationAttributes<EmployeeExperience>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare organisation: string;
  declare role: string | null;
  declare fromDate: string | null;
  declare toDate: string | null;
  declare notes: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmployeeDocument extends Model<
  InferAttributes<EmployeeDocument>,
  InferCreationAttributes<EmployeeDocument>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare fileId: number;
  declare docType: string;
  declare title: string;
  declare file?: NonAttribute<FileObject>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmployeeAssignment extends Model<
  InferAttributes<EmployeeAssignment>,
  InferCreationAttributes<EmployeeAssignment>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare branchId: number;
  declare role: string;
  declare referenceType: string | null;
  declare referenceId: number | null;
  declare fromDate: string | null;
  declare toDate: string | null;
  declare branch?: NonAttribute<Branch>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmploymentContract extends Model<
  InferAttributes<EmploymentContract>,
  InferCreationAttributes<EmploymentContract>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare contractType: string;
  declare startDate: string;
  declare endDate: string | null;
  declare probationMonths: number | null;
  declare noticePeriodDays: CreationOptional<number>;
  declare terms: string | null;
  declare status: CreationOptional<ContractStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class LeaveType extends Model<InferAttributes<LeaveType>, InferCreationAttributes<LeaveType>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare code: string;
  declare name: string;
  declare annualQuota: number | null;
  declare paid: CreationOptional<boolean>;
  declare encashable: CreationOptional<boolean>;
  declare active: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class LeaveApplication extends Model<
  InferAttributes<LeaveApplication>,
  InferCreationAttributes<LeaveApplication>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare leaveTypeId: number;
  declare fromDate: string;
  declare toDate: string;
  declare halfDay: CreationOptional<boolean>;
  declare days: number;
  declare reason: string | null;
  declare status: CreationOptional<LeaveStatus>;
  declare decidedBy: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare decisionNote: CreationOptional<string | null>;
  declare employee?: NonAttribute<Employee>;
  declare leaveType?: NonAttribute<LeaveType>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class StaffAttendance extends Model<
  InferAttributes<StaffAttendance>,
  InferCreationAttributes<StaffAttendance>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare date: string;
  declare status: StaffAttendanceStatus;
  declare checkIn: string | null;
  declare checkOut: string | null;
  declare source: CreationOptional<'manual' | 'biometric' | 'leave'>;
  declare leaveApplicationId: number | null;
  declare remarks: string | null;
  declare leaveApplication?: NonAttribute<LeaveApplication | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmployeeAsset extends Model<
  InferAttributes<EmployeeAsset>,
  InferCreationAttributes<EmployeeAsset>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare name: string;
  declare assetTag: string | null;
  declare issuedOn: string;
  declare returnedOn: string | null;
  declare valuePaise: CreationOptional<number>;
  declare status: CreationOptional<AssetStatus>;
  declare notes: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EmployeeSeparation extends Model<
  InferAttributes<EmployeeSeparation>,
  InferCreationAttributes<EmployeeSeparation>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare employeeId: number;
  declare type: CreationOptional<SeparationType>;
  declare submittedOn: string;
  declare noticePeriodDays: number;
  declare lastWorkingDay: string;
  declare reason: string | null;
  declare status: CreationOptional<SeparationStatus>;
  declare decidedBy: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare employee?: NonAttribute<Employee>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

const S = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const D = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });

export function initHrModels(sequelize: Sequelize) {
  init(Shift, sequelize, 'shifts', {
    branchId: OPT_FK(),
    name: S(100, false),
    startTime: S(5, false),
    endTime: S(5, false),
    graceMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 10 },
    weeklyOffs: { type: DataTypes.JSON, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  init(Employee, sequelize, 'employees', {
    branchId: OPT_FK(),
    userId: OPT_FK(),
    employeeCode: S(30, false),
    name: S(150, false),
    email: S(150),
    mobile: S(20),
    designation: S(100),
    department: S(100),
    employmentType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'full_time' },
    isTeacher: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    dateOfJoining: D(false),
    dateOfBirth: D(),
    dateOfExit: D(),
    gender: S(20),
    address: DataTypes.TEXT,
    pan: S(20),
    uan: S(20),
    esiNumber: S(30),
    bankAccountName: S(150),
    bankAccountNumber: S(40),
    bankIfsc: S(20),
    shiftId: OPT_FK(),
    biometricEnrolmentId: S(50),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    notes: DataTypes.TEXT,
  });
  init(EmployeeQualification, sequelize, 'employee_qualifications', {
    employeeId: FK(),
    degree: S(150, false),
    institution: S(200),
    yearOfPassing: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    grade: S(30),
  });
  init(EmployeeExperience, sequelize, 'employee_experiences', {
    employeeId: FK(),
    organisation: S(200, false),
    role: S(150),
    fromDate: D(),
    toDate: D(),
    notes: DataTypes.TEXT,
  });
  init(EmployeeDocument, sequelize, 'employee_documents', {
    employeeId: FK(),
    fileId: FK(),
    docType: S(50, false),
    title: S(200, false),
  });
  init(EmployeeAssignment, sequelize, 'employee_assignments', {
    employeeId: FK(),
    branchId: FK(),
    role: S(100, false),
    referenceType: S(40),
    referenceId: OPT_FK(),
    fromDate: D(),
    toDate: D(),
  });
  init(EmploymentContract, sequelize, 'employment_contracts', {
    employeeId: FK(),
    contractType: S(30, false),
    startDate: D(false),
    endDate: D(),
    probationMonths: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    noticePeriodDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 30 },
    terms: DataTypes.TEXT,
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
  });
  init(LeaveType, sequelize, 'leave_types', {
    code: S(20, false),
    name: S(100, false),
    annualQuota: decimal('annualQuota', true),
    paid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    encashable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  init(LeaveApplication, sequelize, 'leave_applications', {
    employeeId: FK(),
    leaveTypeId: FK(),
    fromDate: D(false),
    toDate: D(false),
    halfDay: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    days: decimal('days'),
    reason: DataTypes.TEXT,
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    decidedBy: OPT_FK(),
    decidedAt: DataTypes.DATE,
    decisionNote: S(500),
  });
  init(StaffAttendance, sequelize, 'staff_attendance', {
    employeeId: FK(),
    date: D(false),
    status: S(20, false),
    checkIn: S(5),
    checkOut: S(5),
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
    leaveApplicationId: OPT_FK(),
    remarks: S(255),
  });
  init(EmployeeAsset, sequelize, 'employee_assets', {
    employeeId: FK(),
    name: S(150, false),
    assetTag: S(60),
    issuedOn: D(false),
    returnedOn: D(),
    valuePaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'issued' },
    notes: S(500),
  });
  init(EmployeeSeparation, sequelize, 'employee_separations', {
    employeeId: FK(),
    type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'resignation' },
    submittedOn: D(false),
    noticePeriodDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    lastWorkingDay: D(false),
    reason: DataTypes.TEXT,
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'submitted' },
    decidedBy: OPT_FK(),
    decidedAt: DataTypes.DATE,
  });
}

export function associateHrModels() {
  Employee.belongsTo(Shift, { foreignKey: 'shiftId', as: 'shift' });
  EmployeeDocument.belongsTo(FileObject, { foreignKey: 'fileId', as: 'file' });
  EmployeeAssignment.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  LeaveApplication.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  LeaveApplication.belongsTo(LeaveType, { foreignKey: 'leaveTypeId', as: 'leaveType' });
  StaffAttendance.belongsTo(LeaveApplication, { foreignKey: 'leaveApplicationId', as: 'leaveApplication' });
  EmployeeSeparation.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
}
