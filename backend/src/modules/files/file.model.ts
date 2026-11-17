import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

export type FileVisibility = 'private' | 'institute';

/** Metadata for an uploaded object. Bytes live in the storage adapter under `storageKey`. */
export class FileObject extends Model<InferAttributes<FileObject>, InferCreationAttributes<FileObject>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare ownerUserId: number | null;
  declare module: string;
  declare storageDriver: string;
  declare storageKey: string;
  declare originalName: string;
  declare mimeType: string;
  declare sizeBytes: number;
  declare checksumSha256: string | null;
  declare visibility: CreationOptional<FileVisibility>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    FileObject.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        branchId: DataTypes.INTEGER.UNSIGNED,
        ownerUserId: DataTypes.INTEGER.UNSIGNED,
        module: { type: DataTypes.STRING(60), allowNull: false },
        storageDriver: { type: DataTypes.STRING(10), allowNull: false },
        storageKey: { type: DataTypes.STRING(500), allowNull: false },
        originalName: { type: DataTypes.STRING(255), allowNull: false },
        mimeType: { type: DataTypes.STRING(150), allowNull: false },
        sizeBytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
        checksumSha256: DataTypes.STRING(64),
        visibility: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'private' },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'files' },
    );
    registerTenantModel(FileObject);
  }

  toDto() {
    return {
      id: this.id,
      originalName: this.originalName,
      mimeType: this.mimeType,
      sizeBytes: Number(this.sizeBytes),
      module: this.module,
      branchId: this.branchId,
      createdAt: this.createdAt,
    };
  }
}
