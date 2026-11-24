import {
  DataTypes,
  Model,
  Op,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
  type Transaction,
  type WhereOptions,
} from 'sequelize';

/**
 * Global identity. A user can belong to several institutes through `user_roles`; tenant-scoped
 * user lists must always go through memberships (see users.routes.ts).
 *
 * `mobile` is the account's own mobile (unique). Siblings who share a parent's mobile each get an
 * account with no mobile of its own: `sharedMobile` records the mobile they share, which receives
 * their OTPs and messages (`contactMobile`). Set exactly one of the two (a CHECK constraint requires one).
 */
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare mobile: string | null;
  declare sharedMobile: CreationOptional<string | null>;
  declare email: string | null;
  declare passwordHash: string | null;
  declare status: CreationOptional<'active' | 'inactive' | 'blocked'>;
  declare isSuperAdmin: CreationOptional<boolean>;
  declare lastLoginAt: Date | null;
  /** App language chosen by the user (`en`/`hi`); null until they pick one. */
  declare locale: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  toPublic() {
    return {
      id: this.id,
      name: this.name,
      mobile: contactMobile(this),
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
        mobile: { type: DataTypes.STRING(20), allowNull: true, unique: true },
        sharedMobile: { type: DataTypes.STRING(20), allowNull: true },
        email: { type: DataTypes.STRING(150), allowNull: true, unique: true },
        passwordHash: DataTypes.STRING(100),
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
        isSuperAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        lastLoginAt: DataTypes.DATE,
        locale: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'en' },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'users' },
    );
  }
}

/** Where the account's OTPs and messages go: its own mobile, else the one it shares. */
export function contactMobile(user: { mobile: string | null; sharedMobile?: string | null }): string {
  return user.mobile ?? user.sharedMobile ?? '';
}

/** Accounts reached on the mobile(s): the one that owns it and those that share it. */
export function reachedOn(mobile: string | string[]): WhereOptions<User> {
  return { [Op.or]: [{ mobile }, { sharedMobile: mobile }] };
}

/** Search conditions (for an `Op.or` list) matching an account's own or shared mobile. */
export function mobileLike(pattern: string): WhereOptions<User>[] {
  return [{ mobile: { [Op.like]: pattern } }, { sharedMobile: { [Op.like]: pattern } }];
}

/**
 * The accounts reached on a mobile: the owner first, then the others oldest first. `active` keeps
 * only accounts that may sign in.
 */
export async function accountsOnMobile(
  mobile: string,
  opts: { active?: boolean; transaction?: Transaction } = {},
): Promise<User[]> {
  const users = await User.findAll({
    where: { [Op.and]: [reachedOn(mobile), ...(opts.active ? [{ status: 'active' }] : [])] },
    order: [['id', 'ASC']],
    transaction: opts.transaction,
  });
  return users.sort((a, b) => Number(a.mobile === null) - Number(b.mobile === null));
}
