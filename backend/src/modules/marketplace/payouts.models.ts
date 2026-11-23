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
  MktPayoutMethod,
  MktPayoutRunStatus,
  MktPayoutStatus,
  MktRefundInitiator,
  MktRefundStatus,
} from '@erp/shared';
import { registerEncryptedColumns } from '../../infrastructure/database/encrypted-columns';
import { MktOrder, MktOrderItem, MktSaleLedger, MktSeller } from './models';

/** Payout and refund models; platform-wide like the rest of the marketplace (no `institute_id`). */

type Attrs<M extends Model> = InferAttributes<M>;
type Create<M extends Model> = InferCreationAttributes<M>;

export class MktPayoutSettings extends Model<Attrs<MktPayoutSettings>, Create<MktPayoutSettings>> {
  declare id: CreationOptional<number>;
  declare minPayoutPaise: number;
  declare holdDays: number;
  declare refundWindowDays: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktPayoutAccount extends Model<Attrs<MktPayoutAccount>, Create<MktPayoutAccount>> {
  declare id: CreationOptional<number>;
  declare sellerId: number;
  declare method: MktPayoutMethod;
  declare holderName: string;
  declare bankName: string | null;
  declare ifsc: string | null;
  declare accountEncrypted: string;
  declare masked: string;
  declare updatedByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktPayoutRun extends Model<Attrs<MktPayoutRun>, Create<MktPayoutRun>> {
  declare id: CreationOptional<number>;
  declare periodStart: Date;
  declare periodEnd: Date;
  declare eligibleBefore: Date;
  declare status: CreationOptional<MktPayoutRunStatus>;
  declare createdByUserId: number | null;
  declare finalizedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare payouts?: NonAttribute<MktPayout[]>;
}

export class MktPayout extends Model<Attrs<MktPayout>, Create<MktPayout>> {
  declare id: CreationOptional<number>;
  declare runId: number;
  declare sellerId: number;
  declare status: CreationOptional<MktPayoutStatus>;
  declare grossPaise: number;
  declare commissionPaise: number;
  declare refundsPaise: number;
  declare netPaise: number;
  declare entries: number;
  declare reference: CreationOptional<string | null>;
  declare paidToEncrypted: CreationOptional<string | null>;
  declare paidToMasked: CreationOptional<string | null>;
  declare holdReason: CreationOptional<string | null>;
  declare paidAt: CreationOptional<Date | null>;
  declare paidByUserId: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare seller?: NonAttribute<MktSeller>;
  declare run?: NonAttribute<MktPayoutRun>;
}

export class MktRefund extends Model<Attrs<MktRefund>, Create<MktRefund>> {
  declare id: CreationOptional<number>;
  declare orderId: number;
  declare orderItemId: number | null;
  declare userId: number;
  declare amountPaise: number;
  declare reason: string;
  declare status: CreationOptional<MktRefundStatus>;
  declare initiatedBy: MktRefundInitiator;
  declare decisionNote: CreationOptional<string | null>;
  declare decidedByUserId: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare gatewayRefundId: CreationOptional<string | null>;
  /** Set for the refund of an extra payment of an order: only that payment is returned. */
  declare gatewayPaymentId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare order?: NonAttribute<MktOrder>;
  declare item?: NonAttribute<MktOrderItem | null>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const date = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });
/** BIGINT comes back from mysql2 as a string; expose it as a number. */
const paise = (field: string) => ({
  type: DataTypes.BIGINT.UNSIGNED,
  allowNull: false,
  defaultValue: 0,
  get(this: Model) {
    return Number(this.getDataValue(field) ?? 0);
  },
});
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export function initPayoutModels(sequelize: Sequelize) {
  MktPayoutSettings.init(
    {
      id: pk,
      minPayoutPaise: paise('minPayoutPaise'),
      holdDays: { ...uint(false), defaultValue: 30 },
      refundWindowDays: { ...uint(false), defaultValue: 30 },
      ...stamps,
    },
    { sequelize, tableName: 'mkt_payout_settings' },
  );
  MktPayoutAccount.init(
    {
      id: pk,
      sellerId: uint(false),
      method: str(10),
      holderName: str(150),
      bankName: str(150, true),
      ifsc: str(11, true),
      accountEncrypted: { type: DataTypes.TEXT, allowNull: false },
      masked: str(80),
      updatedByUserId: uint(),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_payout_accounts' },
  );
  registerEncryptedColumns(MktPayoutAccount, ['accountEncrypted']);
  MktPayoutRun.init(
    {
      id: pk,
      periodStart: date(false),
      periodEnd: date(false),
      eligibleBefore: date(false),
      status: { ...str(20), defaultValue: 'draft' },
      createdByUserId: uint(),
      finalizedAt: date(),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_payout_runs' },
  );
  MktPayout.init(
    {
      id: pk,
      runId: uint(false),
      sellerId: uint(false),
      status: { ...str(20), defaultValue: 'pending' },
      grossPaise: paise('grossPaise'),
      commissionPaise: paise('commissionPaise'),
      refundsPaise: paise('refundsPaise'),
      netPaise: paise('netPaise'),
      entries: { ...uint(false), defaultValue: 0 },
      reference: str(80, true),
      paidToEncrypted: { type: DataTypes.TEXT, allowNull: true },
      paidToMasked: str(200, true),
      holdReason: str(300, true),
      paidAt: date(),
      paidByUserId: uint(),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_payouts' },
  );
  registerEncryptedColumns(MktPayout, ['paidToEncrypted']);
  MktRefund.init(
    {
      id: pk,
      orderId: uint(false),
      orderItemId: uint(),
      userId: uint(false),
      amountPaise: paise('amountPaise'),
      reason: str(1000),
      status: { ...str(20), defaultValue: 'requested' },
      initiatedBy: str(10),
      decisionNote: str(1000, true),
      decidedByUserId: uint(),
      decidedAt: date(),
      gatewayRefundId: str(120, true),
      gatewayPaymentId: str(120, true),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_refunds' },
  );
}

export function associatePayoutModels() {
  MktPayoutRun.hasMany(MktPayout, { as: 'payouts', foreignKey: 'runId' });
  MktPayout.belongsTo(MktPayoutRun, { as: 'run', foreignKey: 'runId' });
  MktPayout.belongsTo(MktSeller, { as: 'seller', foreignKey: 'sellerId' });
  MktRefund.belongsTo(MktOrder, { as: 'order', foreignKey: 'orderId' });
  MktRefund.belongsTo(MktOrderItem, { as: 'item', foreignKey: 'orderItemId' });
  MktSaleLedger.belongsTo(MktPayout, { as: 'payout', foreignKey: 'payoutId', constraints: false });
}
