import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { AiProviderId } from '@erp/shared';

/** Platform-level (SaaS) AI provider settings. One row per scope; `global` is the only scope for now. */
export class AiSetting extends Model<InferAttributes<AiSetting>, InferCreationAttributes<AiSetting>> {
  declare id: CreationOptional<number>;
  declare scope: string;
  declare provider: AiProviderId;
  declare baseUrl: string;
  declare model: string;
  declare apiKeyEncrypted: string | null;
  declare jsonMode: CreationOptional<boolean>;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** One row per AI call; used for metering, quotas and cost reports. instituteId null = platform call. */
export class AiUsage extends Model<InferAttributes<AiUsage>, InferCreationAttributes<AiUsage>> {
  declare id: CreationOptional<number>;
  declare instituteId: number | null;
  declare userId: number | null;
  declare feature: string;
  declare provider: string;
  declare model: string;
  declare promptTokens: CreationOptional<number>;
  declare completionTokens: CreationOptional<number>;
  declare totalTokens: CreationOptional<number>;
  declare status: 'success' | 'error';
  declare latencyMs: number | null;
  declare error: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initAiModels(sequelize: Sequelize) {
  AiSetting.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      scope: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      provider: { type: DataTypes.STRING(30), allowNull: false },
      baseUrl: { type: DataTypes.STRING(500), allowNull: false },
      model: { type: DataTypes.STRING(150), allowNull: false },
      apiKeyEncrypted: DataTypes.TEXT,
      jsonMode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      updatedBy: DataTypes.INTEGER.UNSIGNED,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'ai_settings' },
  );
  AiUsage.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      instituteId: DataTypes.INTEGER.UNSIGNED,
      userId: DataTypes.INTEGER.UNSIGNED,
      feature: { type: DataTypes.STRING(80), allowNull: false },
      provider: { type: DataTypes.STRING(30), allowNull: false },
      model: { type: DataTypes.STRING(150), allowNull: false },
      promptTokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      completionTokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      totalTokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.STRING(10), allowNull: false },
      latencyMs: DataTypes.INTEGER.UNSIGNED,
      error: DataTypes.STRING(500),
      createdAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'ai_usage', updatedAt: false },
  );
}
