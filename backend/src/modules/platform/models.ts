import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type IntegrationKind = 'gateway' | 'messaging' | 'storage';

/**
 * Super admin (platform-wide) integration settings: SaaS payment gateways, default notification
 * providers and file storage. Not tenant data. Secrets are encrypted at rest and never returned.
 */
export class PlatformIntegration extends Model<
  InferAttributes<PlatformIntegration>,
  InferCreationAttributes<PlatformIntegration>
> {
  declare id: CreationOptional<number>;
  declare kind: IntegrationKind;
  /** Gateway name, messaging channel, or `default` for storage. */
  declare slot: string;
  declare provider: string;
  declare enabled: CreationOptional<boolean>;
  /** Non-secret connection settings and flags. */
  declare settings: CreationOptional<Record<string, unknown>>;
  declare secretsEncrypted: string | null;
  /** Fingerprint of the connection settings the last test ran against (null = untested). */
  declare testedFingerprint: string | null;
  declare lastTestOk: boolean | null;
  declare lastTestedAt: Date | null;
  declare lastTestMessage: string | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initPlatformModels(sequelize: Sequelize) {
  PlatformIntegration.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      slot: { type: DataTypes.STRING(40), allowNull: false },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      settings: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
      secretsEncrypted: { type: DataTypes.TEXT, allowNull: true },
      testedFingerprint: { type: DataTypes.STRING(64), allowNull: true },
      lastTestOk: { type: DataTypes.BOOLEAN, allowNull: true },
      lastTestedAt: { type: DataTypes.DATE, allowNull: true },
      lastTestMessage: { type: DataTypes.STRING(500), allowNull: true },
      updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    {
      sequelize,
      tableName: 'platform_integrations',
      indexes: [{ unique: true, fields: ['kind', 'slot'] }],
    },
  );
}
