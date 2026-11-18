import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  AddonKind,
  AddonStatus,
  BilledPartyDto,
  BillingCycle,
  PlanAddonPrice,
  PlanLimits,
  PlanUsagePricing,
  SaasInvoiceKind,
  SaasInvoiceStatus,
  SaasPaymentMethod,
  SaasPaymentStatus,
  SubscriptionStatus,
} from '@erp/shared';
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
  /** Purchasable add-on packs; null/[] = none. */
  declare addons: CreationOptional<PlanAddonPrice[] | null>;
  /** Overage pricing per metered metric (soft limits); null = hard limits. */
  declare usagePricing: CreationOptional<PlanUsagePricing | null>;
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
  declare billingCycle: BillingCycle;
  declare startsAt: Date;
  /** End of the trial / paid period; null = open-ended (platform managed). */
  declare endsAt: Date | null;
  /** Absolute per-institute limit overrides set by the super admin (applied last). */
  declare limitOverrides: Partial<PlanLimits> | null;
  /** Start of the current paid period (renewals move it forward); null = `startsAt`. */
  declare currentPeriodStart: CreationOptional<Date | null>;
  /** Downgrade scheduled for the end of the period. */
  declare pendingPlanId: CreationOptional<number | null>;
  declare pendingBillingCycle: CreationOptional<BillingCycle | null>;
  /** Manually suspended by the super admin (overrides the computed access state). */
  declare suspendedAt: CreationOptional<Date | null>;
  declare suspendReason: CreationOptional<string | null>;
  declare trialExtendedDays: CreationOptional<number>;
  /** Last day (`YYYY-MM-DD`, end of a UTC month) usage overage was invoiced for. */
  declare overageBilledThrough: CreationOptional<string | null>;
  /** Last lifecycle notice sent (de-duplicates reminders), e.g. `trial_ending:2026-11-20`. */
  declare lastNotice: CreationOptional<string | null>;
  declare plan?: NonAttribute<Plan>;
  declare pendingPlan?: NonAttribute<Plan | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** What paying an invoice does to the subscription. */
export interface InvoiceMeta {
  action?: 'renew' | 'plan_change' | 'addon' | 'overage' | 'manual';
  planId?: number;
  billingCycle?: BillingCycle;
  /** ISO timestamps of the term bought (renew / cycle change). */
  periodStart?: string;
  periodEnd?: string;
  /** `plan_change`: keep the current end date (same-cycle upgrade). */
  keepPeriod?: boolean;
  addonIds?: number[];
  /** `overage`: billed month, `YYYY-MM-01`. */
  month?: string;
  /** Credit note numbers issued against the invoice. */
  creditNotes?: string[];
}

export class SubscriptionInvoice extends Model<
  InferAttributes<SubscriptionInvoice>,
  InferCreationAttributes<SubscriptionInvoice>
> {
  declare id: CreationOptional<number>;
  /** Null once the institute was permanently deleted (invoices are retained tax records). */
  declare instituteId: number | null;
  declare subscriptionId: number | null;
  declare number: string;
  declare kind: SaasInvoiceKind;
  declare status: CreationOptional<SaasInvoiceStatus>;
  declare issueDate: string;
  declare dueDate: string;
  declare periodStart: Date | null;
  declare periodEnd: Date | null;
  declare subtotalPaise: number;
  /** GST rate in basis points (1800 = 18%). */
  declare gstRateBp: number;
  declare cgstPaise: number;
  declare sgstPaise: number;
  declare igstPaise: number;
  declare totalPaise: number;
  declare creditedPaise: CreationOptional<number>;
  declare paidPaise: CreationOptional<number>;
  declare billedTo: BilledPartyDto;
  declare seller: BilledPartyDto & { email: string | null; phone: string | null };
  declare meta: InvoiceMeta | null;
  declare notes: string | null;
  declare paidAt: CreationOptional<Date | null>;
  declare voidedAt: CreationOptional<Date | null>;
  declare voidReason: CreationOptional<string | null>;
  declare createdBy: number | null;
  declare lines?: NonAttribute<SubscriptionInvoiceLine[]>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionInvoiceLine extends Model<
  InferAttributes<SubscriptionInvoiceLine>,
  InferCreationAttributes<SubscriptionInvoiceLine>
> {
  declare id: CreationOptional<number>;
  declare invoiceId: number;
  declare description: string;
  declare sacCode: string | null;
  /** plan | addon:<kind> | overage:<metric> | proration | manual */
  declare itemType: string | null;
  declare quantity: number;
  declare unitPricePaise: number;
  declare amountPaise: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionCreditNote extends Model<
  InferAttributes<SubscriptionCreditNote>,
  InferCreationAttributes<SubscriptionCreditNote>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number | null;
  declare invoiceId: number;
  declare number: string;
  declare taxablePaise: number;
  declare cgstPaise: number;
  declare sgstPaise: number;
  declare igstPaise: number;
  declare amountPaise: number;
  declare reason: string;
  declare billedTo: BilledPartyDto;
  declare seller: BilledPartyDto & { email: string | null; phone: string | null };
  declare createdBy: number | null;
  declare invoice?: NonAttribute<SubscriptionInvoice>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionPayment extends Model<
  InferAttributes<SubscriptionPayment>,
  InferCreationAttributes<SubscriptionPayment>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number | null;
  declare invoiceId: number | null;
  declare amountPaise: number;
  declare feePaise: CreationOptional<number>;
  declare method: SaasPaymentMethod;
  declare gateway: string | null;
  declare gatewayOrderId: string | null;
  declare gatewayPaymentId: CreationOptional<string | null>;
  declare status: SaasPaymentStatus;
  declare reference: string | null;
  declare note: string | null;
  declare idempotencyKey: string | null;
  /** Gateway checkout data, replayed for an idempotent retry of the same checkout. */
  declare checkoutPayload: CreationOptional<Record<string, unknown> | null>;
  declare paidAt: CreationOptional<Date | null>;
  declare recordedBy: number | null;
  declare invoice?: NonAttribute<SubscriptionInvoice | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionWebhookEvent extends Model<
  InferAttributes<SubscriptionWebhookEvent>,
  InferCreationAttributes<SubscriptionWebhookEvent>
> {
  declare id: CreationOptional<number>;
  declare gateway: string;
  declare eventKey: string;
  declare paymentId: number | null;
  declare outcome: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionAddon extends Model<
  InferAttributes<SubscriptionAddon>,
  InferCreationAttributes<SubscriptionAddon>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare subscriptionId: number;
  declare kind: AddonKind;
  declare moduleKey: string | null;
  declare quantity: number;
  declare unitSize: number;
  declare unitPricePaise: number;
  declare billingCycle: BillingCycle;
  declare status: AddonStatus;
  declare cancelAtPeriodEnd: CreationOptional<boolean>;
  declare startsAt: Date | null;
  /** AI credit packs: month (`YYYY-MM-01`) the credits apply to. */
  declare periodMonth: string | null;
  declare invoiceId: number | null;
  declare createdBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionUsage extends Model<
  InferAttributes<SubscriptionUsage>,
  InferCreationAttributes<SubscriptionUsage>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare snapshotDate: string;
  declare students: number;
  declare branches: number;
  declare teachers: number;
  declare storageMb: number;
  declare aiTokensMonth: number;
  /** Included limits on the snapshot day. */
  declare limits: PlanLimits | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Platform-wide billing settings (operator profile, policy). */
export class SubscriptionSetting extends Model<
  InferAttributes<SubscriptionSetting>,
  InferCreationAttributes<SubscriptionSetting>
> {
  declare id: CreationOptional<number>;
  declare key: string;
  declare value: unknown;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SubscriptionSequence extends Model<
  InferAttributes<SubscriptionSequence>,
  InferCreationAttributes<SubscriptionSequence>
> {
  declare id: CreationOptional<number>;
  declare kind: string;
  declare scopeKey: string;
  declare lastValue: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const paise = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const pk = () => ({ type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true });
const stamps = () => ({ createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE });

export function initSubscriptionModels(sequelize: Sequelize) {
  Plan.init(
    {
      id: pk(),
      code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      description: DataTypes.STRING(255),
      priceMonthlyPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      priceYearlyPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      trialDays: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 14 },
      limits: { type: DataTypes.JSON, allowNull: false },
      addons: { type: DataTypes.JSON, allowNull: true },
      usagePricing: { type: DataTypes.JSON, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...stamps(),
    },
    { sequelize, tableName: 'plans' },
  );
  Subscription.init(
    {
      id: pk(),
      instituteId: uint(),
      planId: uint(),
      status: { type: DataTypes.STRING(20), allowNull: false },
      billingCycle: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'monthly' },
      startsAt: { type: DataTypes.DATE, allowNull: false },
      endsAt: DataTypes.DATE,
      limitOverrides: DataTypes.JSON,
      currentPeriodStart: DataTypes.DATE,
      pendingPlanId: uint(true),
      pendingBillingCycle: DataTypes.STRING(10),
      suspendedAt: DataTypes.DATE,
      suspendReason: DataTypes.STRING(255),
      trialExtendedDays: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      overageBilledThrough: DataTypes.DATEONLY,
      lastNotice: DataTypes.STRING(60),
      ...stamps(),
    },
    { sequelize, tableName: 'subscriptions' },
  );
  SubscriptionInvoice.init(
    {
      id: pk(),
      instituteId: uint(true),
      subscriptionId: uint(true),
      number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'open' },
      issueDate: { type: DataTypes.DATEONLY, allowNull: false },
      dueDate: { type: DataTypes.DATEONLY, allowNull: false },
      periodStart: DataTypes.DATE,
      periodEnd: DataTypes.DATE,
      subtotalPaise: paise(),
      gstRateBp: paise(),
      cgstPaise: paise(),
      sgstPaise: paise(),
      igstPaise: paise(),
      totalPaise: paise(),
      creditedPaise: paise(),
      paidPaise: paise(),
      billedTo: { type: DataTypes.JSON, allowNull: false },
      seller: { type: DataTypes.JSON, allowNull: false },
      meta: DataTypes.JSON,
      notes: DataTypes.STRING(500),
      paidAt: DataTypes.DATE,
      voidedAt: DataTypes.DATE,
      voidReason: DataTypes.STRING(255),
      createdBy: uint(true),
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_invoices' },
  );
  SubscriptionInvoiceLine.init(
    {
      id: pk(),
      invoiceId: uint(),
      description: { type: DataTypes.STRING(255), allowNull: false },
      sacCode: DataTypes.STRING(10),
      itemType: DataTypes.STRING(30),
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      unitPricePaise: paise(),
      amountPaise: paise(),
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_invoice_lines' },
  );
  SubscriptionCreditNote.init(
    {
      id: pk(),
      instituteId: uint(true),
      invoiceId: uint(),
      number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      taxablePaise: paise(),
      cgstPaise: paise(),
      sgstPaise: paise(),
      igstPaise: paise(),
      amountPaise: paise(),
      reason: { type: DataTypes.STRING(500), allowNull: false },
      billedTo: { type: DataTypes.JSON, allowNull: false },
      seller: { type: DataTypes.JSON, allowNull: false },
      createdBy: uint(true),
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_credit_notes' },
  );
  SubscriptionPayment.init(
    {
      id: pk(),
      instituteId: uint(true),
      invoiceId: uint(true),
      amountPaise: paise(),
      feePaise: paise(),
      method: { type: DataTypes.STRING(10), allowNull: false },
      gateway: DataTypes.STRING(20),
      gatewayOrderId: DataTypes.STRING(100),
      gatewayPaymentId: DataTypes.STRING(100),
      status: { type: DataTypes.STRING(10), allowNull: false },
      reference: DataTypes.STRING(100),
      note: DataTypes.STRING(255),
      idempotencyKey: { type: DataTypes.STRING(160), unique: true },
      checkoutPayload: DataTypes.JSON,
      paidAt: DataTypes.DATE,
      recordedBy: uint(true),
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_payments' },
  );
  SubscriptionWebhookEvent.init(
    {
      id: pk(),
      gateway: { type: DataTypes.STRING(20), allowNull: false },
      eventKey: { type: DataTypes.STRING(191), allowNull: false },
      paymentId: uint(true),
      outcome: { type: DataTypes.STRING(20), allowNull: false },
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_webhook_events' },
  );
  SubscriptionAddon.init(
    {
      id: pk(),
      instituteId: uint(),
      subscriptionId: uint(),
      kind: { type: DataTypes.STRING(20), allowNull: false },
      moduleKey: DataTypes.STRING(40),
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      unitSize: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      unitPricePaise: paise(),
      billingCycle: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'monthly' },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      startsAt: DataTypes.DATE,
      periodMonth: DataTypes.DATEONLY,
      invoiceId: uint(true),
      createdBy: uint(true),
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_addons' },
  );
  SubscriptionUsage.init(
    {
      id: pk(),
      instituteId: uint(),
      snapshotDate: { type: DataTypes.DATEONLY, allowNull: false },
      students: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      branches: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      teachers: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      storageMb: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      aiTokensMonth: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      limits: DataTypes.JSON,
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_usage' },
  );
  SubscriptionSetting.init(
    {
      id: pk(),
      key: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      value: { type: DataTypes.JSON, allowNull: false },
      updatedBy: uint(true),
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_settings' },
  );
  SubscriptionSequence.init(
    {
      id: pk(),
      kind: { type: DataTypes.STRING(20), allowNull: false },
      scopeKey: { type: DataTypes.STRING(60), allowNull: false },
      lastValue: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      ...stamps(),
    },
    { sequelize, tableName: 'subscription_sequences' },
  );

  registerTenantModel(Subscription);
  registerTenantModel(SubscriptionAddon);
  registerTenantModel(SubscriptionUsage);
  // Retained billing records: guarded like tenant data (platform code passes `tenantBypass`).
  registerTenantModel(SubscriptionInvoice);
  registerTenantModel(SubscriptionPayment);
  registerTenantModel(SubscriptionCreditNote);
}

export function associateSubscriptionModels() {
  Subscription.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });
  Subscription.belongsTo(Plan, { foreignKey: 'pendingPlanId', as: 'pendingPlan' });
  SubscriptionInvoice.hasMany(SubscriptionInvoiceLine, { foreignKey: 'invoiceId', as: 'lines' });
  SubscriptionPayment.belongsTo(SubscriptionInvoice, { foreignKey: 'invoiceId', as: 'invoice' });
  SubscriptionCreditNote.belongsTo(SubscriptionInvoice, { foreignKey: 'invoiceId', as: 'invoice' });
}
