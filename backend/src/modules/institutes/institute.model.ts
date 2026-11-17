import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { InstituteBranding, InstituteStatus } from '@erp/shared';
import { config } from '../../infrastructure/config';

/** The tenant root. Not itself tenant-scoped; access via super admin routes or the current context. */
export class Institute extends Model<InferAttributes<Institute>, InferCreationAttributes<Institute>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare slug: string;
  declare status: CreationOptional<InstituteStatus>;
  declare logoFileId: number | null;
  declare primaryColor: string | null;
  declare secondaryColor: string | null;
  declare address: string | null;
  declare city: string | null;
  declare state: string | null;
  declare registrationNumber: string | null;
  declare gstin: string | null;
  declare contactEmail: string | null;
  declare contactPhone: string | null;
  declare bankDetails: Record<string, string> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  toBranding(): InstituteBranding {
    return {
      id: this.id,
      slug: this.slug,
      name: this.name,
      logoUrl: this.logoFileId
        ? `${config.API_PUBLIC_URL}/api/public/institutes/${this.slug}/logo?v=${this.logoFileId}`
        : null,
      primaryColor: this.primaryColor,
      secondaryColor: this.secondaryColor,
    };
  }

  static initModel(sequelize: Sequelize) {
    Institute.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING(150), allowNull: false },
        slug: { type: DataTypes.STRING(60), allowNull: false, unique: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
        logoFileId: DataTypes.INTEGER.UNSIGNED,
        primaryColor: DataTypes.STRING(9),
        secondaryColor: DataTypes.STRING(9),
        address: DataTypes.TEXT,
        city: DataTypes.STRING(80),
        state: DataTypes.STRING(80),
        registrationNumber: DataTypes.STRING(80),
        gstin: DataTypes.STRING(20),
        contactEmail: DataTypes.STRING(150),
        contactPhone: DataTypes.STRING(20),
        bankDetails: DataTypes.JSON,
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'institutes' },
    );
  }
}
