import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/**
 * Global identity. A user can belong to several institutes through `user_roles`; tenant-scoped
 * user lists must always go through memberships (see users.routes.ts).
 */
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare mobile: string;
  declare email: string | null;
  declare passwordHash: string | null;
  declare status: CreationOptional<'active' | 'inactive' | 'blocked'>;
  declare isSuperAdmin: CreationOptional<boolean>;
  declare lastLoginAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  toPublic() {
    return {
      id: this.id,
      name: this.name,
      mobile: this.mobile,
      email: this.email,
      status: this.status,
      isSuperAdmin: this.isSuperAdmin,
      lastLoginAt: this.lastLoginAt,
    };
  }

  static initModel(sequelize: Sequelize) {
    User.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING(150), allowNull: false },
        mobile: { type: DataTypes.STRING(20), allowNull: false, unique: true },
        email: { type: DataTypes.STRING(150), allowNull: true, unique: true },
        passwordHash: DataTypes.STRING(100),
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
        isSuperAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        lastLoginAt: DataTypes.DATE,
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'users' },
    );
  }
}
