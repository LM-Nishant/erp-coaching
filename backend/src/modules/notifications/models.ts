import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type {
  CampaignAudience,
  CampaignStatus,
  ExternalChannel,
  MessageStatus,
  NotificationChannel,
  RecipientType,
} from '@erp/shared';
import { registerEncryptedColumns } from '../../infrastructure/database/encrypted-columns';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

type Attrs<M extends Model> = InferAttributes<M>;
type Create<M extends Model> = InferCreationAttributes<M>;

/** Per-institute provider for an external channel. Secrets are AES-GCM encrypted JSON. */
export class NotificationProvider extends Model<Attrs<NotificationProvider>, Create<NotificationProvider>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare channel: ExternalChannel;
  declare provider: string;
  declare settings: Record<string, string> | null;
  declare secretsEncrypted: string | null;
  declare isActive: CreationOptional<boolean>;
  declare retryMaxAttempts: CreationOptional<number>;
  declare retryBaseDelaySeconds: CreationOptional<number>;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class NotificationTemplate extends Model<Attrs<NotificationTemplate>, Create<NotificationTemplate>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare eventKey: string;
  declare channel: NotificationChannel;
  declare subject: string | null;
  declare body: string;
  declare providerTemplateId: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Trigger rule: event → channels → recipient types. Absent row = catalogue defaults. */
export class NotificationRule extends Model<Attrs<NotificationRule>, Create<NotificationRule>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare eventKey: string;
  declare channels: NotificationChannel[];
  declare recipientTypes: RecipientType[];
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Opt-in/opt-out per user × channel × event (`*` = whole channel). Doubles as consent record. */
export class NotificationPreference extends Model<
  Attrs<NotificationPreference>,
  Create<NotificationPreference>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare userId: number;
  declare channel: NotificationChannel;
  declare eventKey: CreationOptional<string>;
  declare enabled: boolean;
  declare source: string | null;
  declare ip: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class PushToken extends Model<Attrs<PushToken>, Create<PushToken>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare userId: number;
  declare token: string;
  declare tokenHash: string;
  declare platform: 'web' | 'android' | 'ios';
  declare deviceUid: string | null;
  declare lastSeenAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class NotificationCampaign extends Model<Attrs<NotificationCampaign>, Create<NotificationCampaign>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare title: string;
  declare channels: NotificationChannel[];
  declare subject: string | null;
  declare body: string;
  declare audience: CampaignAudience;
  declare scheduledAt: Date | null;
  declare status: CampaignStatus;
  declare recipientCount: CreationOptional<number>;
  declare messageCount: CreationOptional<number>;
  declare error: string | null;
  declare createdBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** One message per recipient × channel. In-app messages form the user's inbox (`readAt`). */
export class NotificationMessage extends Model<Attrs<NotificationMessage>, Create<NotificationMessage>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare eventKey: string;
  declare channel: NotificationChannel;
  declare userId: number | null;
  declare recipientType: RecipientType | null;
  declare recipientAddress: string | null;
  declare subject: string | null;
  declare body: string;
  declare data: Record<string, unknown> | null;
  declare status: MessageStatus;
  declare provider: string | null;
  declare providerTemplateId: string | null;
  declare providerMessageId: string | null;
  declare attempts: CreationOptional<number>;
  declare maxAttempts: CreationOptional<number>;
  declare nextAttemptAt: Date | null;
  declare lastError: string | null;
  declare campaignId: number | null;
  declare sentAt: Date | null;
  declare deliveredAt: Date | null;
  declare readAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DeliveryAttempt extends Model<Attrs<DeliveryAttempt>, Create<DeliveryAttempt>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare messageId: number;
  declare attemptNo: number;
  declare status: 'sent' | 'delivered' | 'failed';
  declare provider: string;
  declare providerMessageId: string | null;
  declare error: string | null;
  declare durationMs: number | null;
  declare createdAt: CreationOptional<Date>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const ts = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export function initNotificationModels(sequelize: Sequelize) {
  NotificationProvider.init(
    {
      id: pk,
      instituteId: uint(),
      channel: str(20, false),
      provider: str(30, false),
      settings: DataTypes.JSON,
      secretsEncrypted: DataTypes.TEXT,
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      retryMaxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      retryBaseDelaySeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
      updatedBy: uint(true),
      ...ts,
    },
    { sequelize, tableName: 'notification_providers' },
  );
  NotificationTemplate.init(
    {
      id: pk,
      instituteId: uint(),
      eventKey: str(80, false),
      channel: str(20, false),
      subject: str(255),
      body: { type: DataTypes.TEXT, allowNull: false },
      providerTemplateId: str(120),
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...ts,
    },
    { sequelize, tableName: 'notification_templates' },
  );
  NotificationRule.init(
    {
      id: pk,
      instituteId: uint(),
      eventKey: str(80, false),
      channels: { type: DataTypes.JSON, allowNull: false },
      recipientTypes: { type: DataTypes.JSON, allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...ts,
    },
    { sequelize, tableName: 'notification_rules' },
  );
  NotificationPreference.init(
    {
      id: pk,
      instituteId: uint(),
      userId: uint(),
      channel: str(20, false),
      eventKey: { type: DataTypes.STRING(80), allowNull: false, defaultValue: '*' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false },
      source: str(30),
      ip: str(64),
      ...ts,
    },
    { sequelize, tableName: 'notification_preferences' },
  );
  PushToken.init(
    {
      id: pk,
      instituteId: uint(),
      userId: uint(),
      token: str(512, false),
      tokenHash: str(64, false),
      platform: str(10, false),
      deviceUid: str(120),
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      ...ts,
    },
    { sequelize, tableName: 'notification_push_tokens' },
  );
  NotificationCampaign.init(
    {
      id: pk,
      instituteId: uint(),
      branchId: uint(true),
      title: str(150, false),
      channels: { type: DataTypes.JSON, allowNull: false },
      subject: str(255),
      body: { type: DataTypes.TEXT, allowNull: false },
      audience: { type: DataTypes.JSON, allowNull: false },
      scheduledAt: DataTypes.DATE,
      status: str(20, false),
      recipientCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      messageCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error: DataTypes.TEXT,
      createdBy: uint(true),
      ...ts,
    },
    { sequelize, tableName: 'notification_campaigns' },
  );
  NotificationMessage.init(
    {
      id: pk,
      instituteId: uint(),
      branchId: uint(true),
      eventKey: str(80, false),
      channel: str(20, false),
      userId: uint(true),
      recipientType: str(20),
      recipientAddress: str(512),
      subject: str(255),
      body: { type: DataTypes.TEXT, allowNull: false },
      data: DataTypes.JSON,
      status: str(20, false),
      provider: str(30),
      providerTemplateId: str(120),
      providerMessageId: str(190),
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      nextAttemptAt: DataTypes.DATE,
      lastError: DataTypes.TEXT,
      campaignId: uint(true),
      sentAt: DataTypes.DATE,
      deliveredAt: DataTypes.DATE,
      readAt: DataTypes.DATE,
      ...ts,
    },
    { sequelize, tableName: 'notification_messages' },
  );
  DeliveryAttempt.init(
    {
      id: pk,
      instituteId: uint(),
      messageId: uint(),
      attemptNo: { type: DataTypes.INTEGER, allowNull: false },
      status: str(20, false),
      provider: str(30, false),
      providerMessageId: str(190),
      error: DataTypes.TEXT,
      durationMs: DataTypes.INTEGER,
      createdAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'notification_delivery_attempts', updatedAt: false },
  );
  registerTenantModel(NotificationProvider);
  registerEncryptedColumns(NotificationProvider, ['secretsEncrypted']);
  registerTenantModel(NotificationTemplate);
  registerTenantModel(NotificationRule);
  registerTenantModel(NotificationPreference);
  registerTenantModel(PushToken);
  registerTenantModel(NotificationCampaign);
  registerTenantModel(NotificationMessage);
  registerTenantModel(DeliveryAttempt);
}

export function associateNotificationModels() {
  NotificationMessage.hasMany(DeliveryAttempt, { foreignKey: 'messageId', as: 'deliveryAttempts' });
}
