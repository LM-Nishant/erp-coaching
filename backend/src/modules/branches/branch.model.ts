import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

export class Branch extends Model<InferAttributes<Branch>, InferCreationAttributes<Branch>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare name: string;
  declare code: string;
  declare address: string | null;
  declare city: string | null;
  declare phone: string | null;
  declare email: string | null;
  declare status: CreationOptional<'active' | 'closed'>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    Branch.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        name: { type: DataTypes.STRING(150), allowNull: false },
        code: { type: DataTypes.STRING(30), allowNull: false },
        address: DataTypes.TEXT,
        city: DataTypes.STRING(80),
        phone: DataTypes.STRING(20),
        email: DataTypes.STRING(150),
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'branches' },
    );
    registerTenantModel(Branch);
  }
}
