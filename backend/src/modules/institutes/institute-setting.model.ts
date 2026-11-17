import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type Sequelize } from 'sequelize';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

/** Key/value configuration per institute (numbering formats, late fee policy, attendance methods...). */
export class InstituteSetting extends Model<InferAttributes<InstituteSetting>, InferCreationAttributes<InstituteSetting>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare key: string;
  declare value: unknown;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    InstituteSetting.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        key: { type: DataTypes.STRING(120), allowNull: false },
        value: { type: DataTypes.JSON, allowNull: true },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'institute_settings' },
    );
    registerTenantModel(InstituteSetting);
  }
}
