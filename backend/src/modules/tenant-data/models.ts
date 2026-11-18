import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { DataExportStatus, DeletionRequestStatus, DeletionSummaryDto } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

/** A background export of all of an institute's data (zip archive in storage, short-lived links). */
export class DataExport extends Model<InferAttributes<DataExport>, InferCreationAttributes<DataExport>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare status: CreationOptional<DataExportStatus>;
  declare includeMedia: boolean;
  declare requestedBy: number | null;
  /** Snapshot: the requester may be a super admin or later be deleted. */
  declare requestedByName: string | null;
  declare storageKey: CreationOptional<string | null>;
  declare sizeBytes: CreationOptional<number | null>;
  declare tableCount: CreationOptional<number | null>;
  declare rowCount: CreationOptional<number | null>;
  declare fileCount: CreationOptional<number | null>;
  declare error: CreationOptional<string | null>;
  declare startedAt: CreationOptional<Date | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare expiresAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/**
 * Institute deletion workflow. Not tenant data: the row outlives the institute (its `institute_id`
 * is set to NULL by the purge) as the permanent record of who asked, who approved and what was removed.
 */
export class InstituteDeletionRequest extends Model<
  InferAttributes<InstituteDeletionRequest>,
  InferCreationAttributes<InstituteDeletionRequest>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number | null;
  /** The institute's id, kept after the institute row is deleted. */
  declare instituteRefId: number;
  declare instituteName: string;
  declare instituteSlug: string;
  declare status: CreationOptional<DeletionRequestStatus>;
  declare reason: string | null;
  declare requestedBy: number | null;
  declare requestedByName: string | null;
  declare decidedBy: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare decisionNote: CreationOptional<string | null>;
  /** Institute status before approval deactivated it (restored when an approved request is cancelled). */
  declare previousInstituteStatus: CreationOptional<string | null>;
  declare scheduledFor: CreationOptional<Date | null>;
  declare startedAt: CreationOptional<Date | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare summary: CreationOptional<DeletionSummaryDto | null>;
  /** Accounts to remove once the institute's rows are gone (saved so a retried purge still finds them). */
  declare pendingUserIds: CreationOptional<number[] | null>;
  declare error: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

export function initTenantDataModels(sequelize: Sequelize) {
  DataExport.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      instituteId: uint(false),
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      includeMedia: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      requestedBy: uint(),
      requestedByName: DataTypes.STRING(150),
      storageKey: DataTypes.STRING(500),
      sizeBytes: DataTypes.BIGINT.UNSIGNED,
      tableCount: uint(),
      rowCount: uint(),
      fileCount: uint(),
      error: DataTypes.STRING(1000),
      startedAt: DataTypes.DATE,
      completedAt: DataTypes.DATE,
      expiresAt: DataTypes.DATE,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'data_exports' },
  );
  registerTenantModel(DataExport);

  InstituteDeletionRequest.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      instituteId: uint(),
      instituteRefId: uint(false),
      instituteName: { type: DataTypes.STRING(200), allowNull: false },
      instituteSlug: { type: DataTypes.STRING(100), allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      reason: DataTypes.STRING(1000),
      requestedBy: uint(),
      requestedByName: DataTypes.STRING(150),
      decidedBy: uint(),
      decidedAt: DataTypes.DATE,
      decisionNote: DataTypes.STRING(1000),
      previousInstituteStatus: DataTypes.STRING(20),
      scheduledFor: DataTypes.DATE,
      startedAt: DataTypes.DATE,
      completedAt: DataTypes.DATE,
      summary: DataTypes.JSON,
      pendingUserIds: DataTypes.JSON,
      error: DataTypes.STRING(2000),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'institute_deletion_requests' },
  );
}
