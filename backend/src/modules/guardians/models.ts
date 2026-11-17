import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { GuardianLinkStatus, GuardianRelation } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { Student } from '../students/models';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

/** Guardian profile in an institute. The login identity (with the Parent role) is `users.id`. */
export class Guardian extends Model<InferAttributes<Guardian>, InferCreationAttributes<Guardian>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare userId: number;
  declare name: string;
  declare mobile: string;
  declare email: CreationOptional<string | null>;
  declare occupation: CreationOptional<string | null>;
  declare address: CreationOptional<string | null>;
  declare links?: NonAttribute<StudentGuardian[]>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class StudentGuardian extends Model<
  InferAttributes<StudentGuardian>,
  InferCreationAttributes<StudentGuardian>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentId: number;
  declare guardianId: number;
  declare relation: CreationOptional<GuardianRelation>;
  declare isPrimary: CreationOptional<boolean>;
  declare status: CreationOptional<GuardianLinkStatus>;
  declare guardian?: NonAttribute<Guardian>;
  declare student?: NonAttribute<Student>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initGuardianModels(sequelize: Sequelize) {
  Guardian.init(
    {
      id: pk,
      instituteId: uint(),
      userId: uint(),
      name: { type: DataTypes.STRING(150), allowNull: false },
      mobile: { type: DataTypes.STRING(20), allowNull: false },
      email: DataTypes.STRING(150),
      occupation: DataTypes.STRING(100),
      address: DataTypes.TEXT,
      ...stamps,
    },
    { sequelize, tableName: 'guardians' },
  );
  StudentGuardian.init(
    {
      id: pk,
      instituteId: uint(),
      studentId: uint(),
      guardianId: uint(),
      relation: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'guardian' },
      isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
      ...stamps,
    },
    { sequelize, tableName: 'student_guardians' },
  );
  registerTenantModel(Guardian);
  registerTenantModel(StudentGuardian);
}

export function associateGuardianModels() {
  Guardian.hasMany(StudentGuardian, { foreignKey: 'guardianId', as: 'links' });
  StudentGuardian.belongsTo(Guardian, { foreignKey: 'guardianId', as: 'guardian' });
  StudentGuardian.belongsTo(Student, { foreignKey: 'studentId', as: 'student' });
}
