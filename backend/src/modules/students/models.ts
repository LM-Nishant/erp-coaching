import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { AcademicInfo, StudentSource, StudentStatus } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { FileObject } from '../files/file.model';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export class Student extends Model<InferAttributes<Student>, InferCreationAttributes<Student>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  /** Login account (student role). Null only for duplicates explicitly allowed by an admin. */
  declare userId: number | null;
  declare admissionNumber: string;
  declare rollNumber: CreationOptional<string | null>;
  declare name: string;
  declare mobile: string;
  declare email: CreationOptional<string | null>;
  declare dateOfBirth: CreationOptional<string | null>;
  declare gender: CreationOptional<'male' | 'female' | 'other' | null>;
  declare address: CreationOptional<string | null>;
  declare city: CreationOptional<string | null>;
  declare state: CreationOptional<string | null>;
  declare pincode: CreationOptional<string | null>;
  declare idType: CreationOptional<string | null>;
  declare idNumber: CreationOptional<string | null>;
  declare photoFileId: CreationOptional<number | null>;
  declare academicInfo: CreationOptional<AcademicInfo | null>;
  declare customFields: CreationOptional<Record<string, unknown> | null>;
  declare status: CreationOptional<StudentStatus>;
  declare statusReason: CreationOptional<string | null>;
  declare source: CreationOptional<StudentSource>;
  declare admittedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    Student.init(
      {
        id: pk,
        instituteId: uint(),
        branchId: uint(),
        userId: uint(true),
        admissionNumber: { type: DataTypes.STRING(60), allowNull: false },
        rollNumber: DataTypes.STRING(60),
        name: { type: DataTypes.STRING(150), allowNull: false },
        mobile: { type: DataTypes.STRING(20), allowNull: false },
        email: DataTypes.STRING(150),
        dateOfBirth: DataTypes.DATEONLY,
        gender: DataTypes.STRING(10),
        address: DataTypes.TEXT,
        city: DataTypes.STRING(80),
        state: DataTypes.STRING(80),
        pincode: DataTypes.STRING(12),
        idType: DataTypes.STRING(40),
        idNumber: DataTypes.STRING(60),
        photoFileId: uint(true),
        academicInfo: DataTypes.JSON,
        customFields: DataTypes.JSON,
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
        statusReason: DataTypes.STRING(255),
        source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'admin' },
        admittedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        ...stamps,
      },
      { sequelize, tableName: 'students' },
    );
    registerTenantModel(Student);
  }
}

export class AdmissionSequence extends Model<
  InferAttributes<AdmissionSequence>,
  InferCreationAttributes<AdmissionSequence>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare kind: 'admission' | 'roll';
  declare scopeKey: string;
  declare lastValue: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class StudentDocument extends Model<
  InferAttributes<StudentDocument>,
  InferCreationAttributes<StudentDocument>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentId: number;
  declare fileId: number;
  declare docType: string;
  declare title: string | null;
  declare uploadedByUserId: number | null;
  declare file?: FileObject;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class StudentHistory extends Model<
  InferAttributes<StudentHistory>,
  InferCreationAttributes<StudentHistory>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentId: number;
  declare eventType: string;
  declare fromValue: string | null;
  declare toValue: string | null;
  declare details: Record<string, unknown> | null;
  declare actorUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class StudentAcademicRecord extends Model<
  InferAttributes<StudentAcademicRecord>,
  InferCreationAttributes<StudentAcademicRecord>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentId: number;
  declare academicYear: string | null;
  declare institution: string | null;
  declare classGrade: string | null;
  declare board: string | null;
  declare result: string | null;
  declare percentage: number | null;
  declare remarks: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initStudentModels(sequelize: Sequelize) {
  Student.initModel(sequelize);
  AdmissionSequence.init(
    {
      id: pk,
      instituteId: uint(),
      kind: { type: DataTypes.STRING(20), allowNull: false },
      scopeKey: { type: DataTypes.STRING(120), allowNull: false },
      lastValue: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      ...stamps,
    },
    { sequelize, tableName: 'admission_sequences' },
  );
  StudentDocument.init(
    {
      id: pk,
      instituteId: uint(),
      studentId: uint(),
      fileId: uint(),
      docType: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'other' },
      title: DataTypes.STRING(150),
      uploadedByUserId: uint(true),
      ...stamps,
    },
    { sequelize, tableName: 'student_documents' },
  );
  StudentHistory.init(
    {
      id: pk,
      instituteId: uint(),
      studentId: uint(),
      eventType: { type: DataTypes.STRING(40), allowNull: false },
      fromValue: DataTypes.STRING(150),
      toValue: DataTypes.STRING(150),
      details: DataTypes.JSON,
      actorUserId: uint(true),
      ...stamps,
    },
    { sequelize, tableName: 'student_history', freezeTableName: true },
  );
  StudentAcademicRecord.init(
    {
      id: pk,
      instituteId: uint(),
      studentId: uint(),
      academicYear: DataTypes.STRING(20),
      institution: DataTypes.STRING(150),
      classGrade: DataTypes.STRING(40),
      board: DataTypes.STRING(60),
      result: DataTypes.STRING(60),
      percentage: {
        type: DataTypes.DECIMAL(5, 2),
        get(this: StudentAcademicRecord) {
          const v = this.getDataValue('percentage');
          return v === null || v === undefined ? null : Number(v);
        },
      },
      remarks: DataTypes.STRING(255),
      ...stamps,
    },
    { sequelize, tableName: 'student_academic_records' },
  );
  for (const m of [AdmissionSequence, StudentDocument, StudentHistory, StudentAcademicRecord])
    registerTenantModel(m as never);
}

export function associateStudentModels() {
  StudentDocument.belongsTo(FileObject, { foreignKey: 'fileId', as: 'file' });
}
