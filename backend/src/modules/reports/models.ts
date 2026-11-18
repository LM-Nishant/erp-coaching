import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { ReportExportFormat, ReportExportStatus, ReportFiltersInput, ReportKey } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import type { StoredReportRequest } from './scope';

/**
 * A requested report export (CSV/XLSX/PDF). `scope` is the access-checked scope resolved when the
 * export was requested, so a background job renders exactly what the requester was allowed to see.
 * Files expire; only the requester can list or download their exports.
 */
export class ReportExport extends Model<
  InferAttributes<ReportExport>,
  InferCreationAttributes<ReportExport>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare userId: number;
  declare reportKey: ReportKey;
  declare format: ReportExportFormat;
  declare status: CreationOptional<ReportExportStatus>;
  declare filters: ReportFiltersInput;
  declare scope: StoredReportRequest;
  declare rowCount: number | null;
  declare fileId: number | null;
  declare fileName: string | null;
  declare error: string | null;
  declare expiresAt: Date | null;
  declare completedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    ReportExport.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        reportKey: { type: DataTypes.STRING(40), allowNull: false },
        format: { type: DataTypes.STRING(8), allowNull: false },
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
        filters: { type: DataTypes.JSON, allowNull: false },
        scope: { type: DataTypes.JSON, allowNull: false },
        rowCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
        fileId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
        fileName: { type: DataTypes.STRING(200), allowNull: true },
        error: { type: DataTypes.STRING(500), allowNull: true },
        expiresAt: { type: DataTypes.DATE, allowNull: true },
        completedAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'report_exports' },
    );
    // Short-lived download records: purged with the institute and left out of its data export.
    registerTenantModel(ReportExport, { retainOnInstituteDeletion: false });
  }
}
