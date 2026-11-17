import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { AdmissionFormPurpose, ApplicationStatus, EnquiryStatus, FormFieldDef } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export class AdmissionForm extends Model<
  InferAttributes<AdmissionForm>,
  InferCreationAttributes<AdmissionForm>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare name: string;
  declare description: string | null;
  declare purpose: AdmissionFormPurpose;
  declare fields: FormFieldDef[];
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Enquiry extends Model<InferAttributes<Enquiry>, InferCreationAttributes<Enquiry>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare name: string;
  declare mobile: string;
  declare email: string | null;
  declare source: string;
  declare status: CreationOptional<EnquiryStatus>;
  declare counsellorUserId: number | null;
  declare courseInterest: string | null;
  /** No FK yet: `courses` belongs to the academics module. */
  declare courseId: number | null;
  declare notes: string | null;
  declare nextFollowUpAt: CreationOptional<Date | null>;
  declare studentId: CreationOptional<number | null>;
  declare customFields: Record<string, unknown> | null;
  declare createdByUserId: number | null;
  declare counsellor?: NonAttribute<User | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class EnquiryFollowUp extends Model<
  InferAttributes<EnquiryFollowUp>,
  InferCreationAttributes<EnquiryFollowUp>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare enquiryId: number;
  declare note: string | null;
  declare outcome: string | null;
  declare scheduledAt: Date | null;
  declare completedAt: CreationOptional<Date | null>;
  declare remindedAt: CreationOptional<Date | null>;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class AdmissionApplication extends Model<
  InferAttributes<AdmissionApplication>,
  InferCreationAttributes<AdmissionApplication>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare enquiryId: number | null;
  declare formId: number | null;
  declare name: string;
  declare mobile: string;
  declare email: string | null;
  /** No FKs yet: `courses` / `batches` belong to the academics module. */
  declare courseId: number | null;
  declare batchId: number | null;
  declare status: CreationOptional<ApplicationStatus>;
  declare waitlistPosition: CreationOptional<number | null>;
  declare formData: Record<string, unknown> | null;
  declare studentId: CreationOptional<number | null>;
  declare remarks: CreationOptional<string | null>;
  declare decidedByUserId: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initAdmissionModels(sequelize: Sequelize) {
  AdmissionForm.init(
    {
      id: pk,
      instituteId: uint(),
      branchId: uint(true),
      name: { type: DataTypes.STRING(150), allowNull: false },
      description: DataTypes.TEXT,
      purpose: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'admission' },
      fields: { type: DataTypes.JSON, allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...stamps,
    },
    { sequelize, tableName: 'admission_forms' },
  );
  Enquiry.init(
    {
      id: pk,
      instituteId: uint(),
      branchId: uint(),
      name: { type: DataTypes.STRING(150), allowNull: false },
      mobile: { type: DataTypes.STRING(20), allowNull: false },
      email: DataTypes.STRING(150),
      source: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new' },
      counsellorUserId: uint(true),
      courseInterest: DataTypes.STRING(150),
      courseId: uint(true),
      notes: DataTypes.TEXT,
      nextFollowUpAt: DataTypes.DATE,
      studentId: uint(true),
      customFields: DataTypes.JSON,
      createdByUserId: uint(true),
      ...stamps,
    },
    { sequelize, tableName: 'enquiries' },
  );
  EnquiryFollowUp.init(
    {
      id: pk,
      instituteId: uint(),
      enquiryId: uint(),
      note: DataTypes.TEXT,
      outcome: DataTypes.STRING(40),
      scheduledAt: DataTypes.DATE,
      completedAt: DataTypes.DATE,
      remindedAt: DataTypes.DATE,
      createdByUserId: uint(true),
      ...stamps,
    },
    { sequelize, tableName: 'enquiry_follow_ups' },
  );
  AdmissionApplication.init(
    {
      id: pk,
      instituteId: uint(),
      branchId: uint(),
      enquiryId: uint(true),
      formId: uint(true),
      name: { type: DataTypes.STRING(150), allowNull: false },
      mobile: { type: DataTypes.STRING(20), allowNull: false },
      email: DataTypes.STRING(150),
      courseId: uint(true),
      batchId: uint(true),
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      waitlistPosition: uint(true),
      formData: DataTypes.JSON,
      studentId: uint(true),
      remarks: DataTypes.STRING(255),
      decidedByUserId: uint(true),
      decidedAt: DataTypes.DATE,
      ...stamps,
    },
    { sequelize, tableName: 'admission_applications' },
  );
  for (const m of [AdmissionForm, Enquiry, EnquiryFollowUp, AdmissionApplication])
    registerTenantModel(m as never);
}

export function associateAdmissionModels() {
  Enquiry.belongsTo(User, { foreignKey: 'counsellorUserId', as: 'counsellor' });
}
