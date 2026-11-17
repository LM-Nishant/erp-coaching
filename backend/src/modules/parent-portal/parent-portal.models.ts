import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { ParentPortalSectionDto } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { Student } from '../students/models';

export class ParentMonthlyReport extends Model<
  InferAttributes<ParentMonthlyReport>,
  InferCreationAttributes<ParentMonthlyReport>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare studentId: number;
  declare period: string;
  declare sections: ParentPortalSectionDto[];
  declare generatedAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare student?: NonAttribute<Student | null>;

  static initModel(sequelize: Sequelize) {
    ParentMonthlyReport.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        branchId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        studentId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        period: { type: DataTypes.CHAR(7), allowNull: false },
        sections: { type: DataTypes.JSON, allowNull: false },
        generatedAt: { type: DataTypes.DATE, allowNull: false },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'parent_monthly_reports' },
    );
    registerTenantModel(ParentMonthlyReport);
  }
}

export function initParentPortalModels(sequelize: Sequelize) {
  ParentMonthlyReport.initModel(sequelize);
}

export function associateParentPortalModels() {
  ParentMonthlyReport.belongsTo(Student, { foreignKey: 'studentId', as: 'student' });
}
