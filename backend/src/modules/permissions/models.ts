import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type NonAttribute, type Sequelize } from 'sequelize';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { Branch } from '../branches/branch.model';
import { Institute } from '../institutes/institute.model';

export class Permission extends Model<InferAttributes<Permission>, InferCreationAttributes<Permission>> {
  declare id: CreationOptional<number>;
  declare module: string;
  declare action: string;
  declare key: string;
  declare label: string;
}

/** `instituteId = null` → system role template (shared by all institutes, managed by code). */
export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<number>;
  declare instituteId: number | null;
  declare slug: string;
  declare name: string;
  declare description: string | null;
  declare isSystem: CreationOptional<boolean>;
  declare permissions?: NonAttribute<Permission[]>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class RolePermission extends Model<InferAttributes<RolePermission>, InferCreationAttributes<RolePermission>> {
  declare roleId: number;
  declare permissionId: number;
}

/** Role assignment. `branchId = null` → institute-wide; otherwise only within that branch. */
export class UserRole extends Model<InferAttributes<UserRole>, InferCreationAttributes<UserRole>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare roleId: number;
  declare instituteId: number;
  declare branchId: number | null;
  declare role?: NonAttribute<Role>;
  declare user?: NonAttribute<User>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Branch access membership (e.g. a teacher working in two branches). */
export class UserBranch extends Model<InferAttributes<UserBranch>, InferCreationAttributes<UserBranch>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare instituteId: number;
  declare branchId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

export function initPermissionModels(sequelize: Sequelize) {
  Permission.init(
    {
      id: pk,
      module: { type: DataTypes.STRING(60), allowNull: false },
      action: { type: DataTypes.STRING(20), allowNull: false },
      key: { type: DataTypes.STRING(90), allowNull: false, unique: true },
      label: { type: DataTypes.STRING(120), allowNull: false },
    },
    { sequelize, tableName: 'permissions', timestamps: false },
  );
  Role.init(
    {
      id: pk,
      instituteId: uint(true),
      slug: { type: DataTypes.STRING(60), allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      description: DataTypes.STRING(255),
      isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'roles' },
  );
  RolePermission.init(
    {
      roleId: { ...uint(), primaryKey: true },
      permissionId: { ...uint(), primaryKey: true },
    },
    { sequelize, tableName: 'role_permissions', timestamps: false },
  );
  UserRole.init(
    {
      id: pk,
      userId: uint(),
      roleId: uint(),
      instituteId: uint(),
      branchId: uint(true),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'user_roles' },
  );
  UserBranch.init(
    {
      id: pk,
      userId: uint(),
      instituteId: uint(),
      branchId: uint(),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'user_branches' },
  );
  registerTenantModel(UserRole);
  registerTenantModel(UserBranch);
}

export function associatePermissionModels() {
  Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'roleId', otherKey: 'permissionId', as: 'permissions' });
  Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permissionId', otherKey: 'roleId', as: 'roles' });
  UserRole.belongsTo(Role, { foreignKey: 'roleId', as: 'role' });
  UserRole.belongsTo(User, { foreignKey: 'userId', as: 'user' });
  UserRole.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  UserRole.belongsTo(Institute, { foreignKey: 'instituteId', as: 'institute' });
  User.hasMany(UserRole, { foreignKey: 'userId', as: 'roleAssignments' });
  UserBranch.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  User.hasMany(UserBranch, { foreignKey: 'userId', as: 'branchMemberships' });
}
