import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/**
 * Personal inbox item of a user who belongs to no institute (marketplace learners, independent instructors).
 * Deliberately not a tenant model: it belongs to the user.
 */
export class PlatformMessage extends Model<
  InferAttributes<PlatformMessage>,
  InferCreationAttributes<PlatformMessage>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare eventKey: string;
  declare subject: string | null;
  declare body: string;
  declare data: Record<string, unknown> | null;
  declare readAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Push device of a user without an institute (FCM / APNs token, or a web mock token). */
export class PlatformPushToken extends Model<
  InferAttributes<PlatformPushToken>,
  InferCreationAttributes<PlatformPushToken>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare token: string;
  declare tokenHash: string;
  declare platform: 'web' | 'android' | 'ios';
  declare deviceUid: string | null;
  declare lastSeenAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = { type: DataTypes.INTEGER.UNSIGNED, allowNull: false };
const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const ts = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export function initPlatformInboxModels(sequelize: Sequelize) {
  PlatformMessage.init(
    {
      id: pk,
      userId: uint,
      eventKey: str(80, false),
      subject: str(255),
      body: { type: DataTypes.TEXT, allowNull: false },
      data: DataTypes.JSON,
      readAt: DataTypes.DATE,
      ...ts,
    },
    { sequelize, tableName: 'notification_platform_messages' },
  );
  PlatformPushToken.init(
    {
      id: pk,
      userId: uint,
      token: str(512, false),
      tokenHash: str(64, false),
      platform: str(10, false),
      deviceUid: str(120),
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      ...ts,
    },
    { sequelize, tableName: 'notification_platform_push_tokens' },
  );
}
