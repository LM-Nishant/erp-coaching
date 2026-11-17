import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { PlanLimits, SubscriptionStatus } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

export class Plan extends Model<InferAttributes<Plan>, InferCreationAttributes<Plan>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare name: string;
  declare description: string | null;
  declare priceMonthlyPaise: number;
  declare priceYearlyPaise: number;
  declare trialDays: CreationOptional<number>;
  declare limits: PlanLimits;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Subscription extends Model<
  InferAttributes<Subscription>,
  InferCreationAttributes<Subscription>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare planId: number;
  declare status: SubscriptionStatus;
  declare billingCycle: 'monthly' | 'yearly';
  declare startsAt: Date;
  declare endsAt: Date | null;
  /** Per-institute overrides on top of plan limits (add-ons). */
  declare limitOverrides: Partial<PlanLimits> | null;
  declare plan?: NonAttribute<Plan>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initSubscriptionModels(sequelize: Sequelize) {
  Plan.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      description: DataTypes.STRING(255),
      priceMonthlyPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      priceYearlyPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      trialDays: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 14 },
      limits: { type: DataTypes.JSON, allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'plans' },
  );
  Subscription.init(
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      planId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      billingCycle: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'monthly' },
      startsAt: { type: DataTypes.DATE, allowNull: false },
      endsAt: DataTypes.DATE,
      limitOverrides: DataTypes.JSON,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'subscriptions' },
  );
  registerTenantModel(Subscription);
}

export function associateSubscriptionModels() {
  Subscription.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });
}
