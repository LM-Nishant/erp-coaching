import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type ModelAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  AmountMode,
  CourseBatchIssue,
  FeeAccountStatus,
  FeeAdjustmentStatus,
  FeeAdjustmentType,
  FeeApprovalStatus,
  FeeComponentLine,
  FeeCourseEnrolmentStatus,
  FeeInstalmentStatus,
  FeePaymentMode,
  FeePaymentStatus,
  FeeSettings,
  FeeStructureKind,
  FeeStructureStatus,
  FinanceEntryKind,
  InstalmentPlan,
  OfflinePaymentMode,
  PaymentGatewayKey,
} from '@erp/shared';
import { registerEncryptedColumns } from '../../infrastructure/database/encrypted-columns';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { Student } from '../students/api';

const PK = () => ({ type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true });
const FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false });
const OPT_FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
const TS = () => ({ createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE });
const S = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const D = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
const DT = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });
const B = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const I = (defaultValue = 0) => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue });
const J = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });

/** BIGINT/DECIMAL come back from mysql2 as strings; expose them as numbers. */
function num(
  name: string,
  type: DataTypes.DataType,
  allowNull = false,
  defaultValue: number | undefined = 0,
) {
  return {
    type,
    allowNull,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    get(this: Model) {
      const v = this.getDataValue(name);
      return v == null ? null : Number(v);
    },
  };
}
const money = (name: string) => num(name, DataTypes.BIGINT);
const dec = (name: string) => num(name, DataTypes.DECIMAL(14, 3), false, undefined);

type AnyModelStatic = {
  init: (attrs: ModelAttributes, opts: { sequelize: Sequelize; tableName: string }) => unknown;
};
function init(model: unknown, sequelize: Sequelize, tableName: string, attrs: ModelAttributes) {
  (model as AnyModelStatic).init(
    { id: PK(), instituteId: FK(), ...attrs, ...TS() },
    { sequelize, tableName },
  );
  registerTenantModel(model as never);
}

type Base = { id: CreationOptional<number>; instituteId: number };
type Stamps = { createdAt: CreationOptional<Date>; updatedAt: CreationOptional<Date> };

export class FeeSettingsRow extends Model<
  InferAttributes<FeeSettingsRow>,
  InferCreationAttributes<FeeSettingsRow>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare settings: FeeSettings;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeHead extends Model<InferAttributes<FeeHead>, InferCreationAttributes<FeeHead>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare name: string;
  declare code: string;
  declare taxable: CreationOptional<boolean>;
  declare active: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeStructure extends Model<
  InferAttributes<FeeStructure>,
  InferCreationAttributes<FeeStructure>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number | null;
  declare familyId: number | null;
  declare version: CreationOptional<number>;
  declare kind: CreationOptional<FeeStructureKind>;
  declare courseId: number | null;
  declare batchId: number | null;
  declare subjectId: number | null;
  declare academicSessionId: number | null;
  declare name: string;
  declare status: CreationOptional<FeeStructureStatus>;
  declare effectiveFrom: string;
  declare components: FeeComponentLine[];
  declare total: number;
  declare instalmentPlan: InstalmentPlan;
  declare createdByUserId: number | null;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeConcessionRule extends Model<
  InferAttributes<FeeConcessionRule>,
  InferCreationAttributes<FeeConcessionRule>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare name: string;
  declare type: 'concession' | 'scholarship' | 'discount';
  declare mode: AmountMode;
  declare value: number;
  declare requiresApproval: CreationOptional<boolean>;
  declare active: CreationOptional<boolean>;
  declare description: string | null;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeAccount extends Model<InferAttributes<FeeAccount>, InferCreationAttributes<FeeAccount>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number;
  declare studentId: number;
  declare studentUserId: number | null;
  declare structureId: number | null;
  declare courseId: number | null;
  declare batchId: number | null;
  declare subjectId: number | null;
  declare academicSessionId: number | null;
  declare title: string;
  declare gross: CreationOptional<number>;
  declare taxableGross: CreationOptional<number>;
  declare discount: CreationOptional<number>;
  declare charges: CreationOptional<number>;
  declare lateFee: CreationOptional<number>;
  declare paid: CreationOptional<number>;
  declare advance: CreationOptional<number>;
  declare status: CreationOptional<FeeAccountStatus>;
  declare source: CreationOptional<string>;
  declare sourceRef: string | null;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
  declare student?: NonAttribute<Student>;
  declare instalments?: NonAttribute<FeeInstalment[]>;

  /** Total payable: gross − discounts + charges + late fees. */
  get net(): NonAttribute<number> {
    return this.gross - this.discount + this.charges + this.lateFee;
  }
  get balance(): NonAttribute<number> {
    return this.net - this.paid;
  }
}

export class FeeInstalment extends Model<
  InferAttributes<FeeInstalment>,
  InferCreationAttributes<FeeInstalment>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare accountId: number;
  declare seq: number;
  declare label: string;
  declare dueDate: string;
  declare amount: number;
  declare lateFee: CreationOptional<number>;
  declare paid: CreationOptional<number>;
  declare status: CreationOptional<FeeInstalmentStatus>;
  declare reminderSentAt: CreationOptional<Date | null>;
  declare overdueNotifiedAt: CreationOptional<Date | null>;
  declare lateFeeAppliedOn: CreationOptional<string | null>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
  declare account?: NonAttribute<FeeAccount>;

  get balance(): NonAttribute<number> {
    return this.amount + this.lateFee - this.paid;
  }
}

export class FeeAdjustment extends Model<
  InferAttributes<FeeAdjustment>,
  InferCreationAttributes<FeeAdjustment>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare accountId: number;
  declare ruleId: number | null;
  declare type: FeeAdjustmentType;
  declare mode: AmountMode;
  declare value: number;
  declare amount: number;
  declare reason: string | null;
  declare status: CreationOptional<FeeAdjustmentStatus>;
  declare requestedByUserId: number | null;
  declare decidedByUserId: CreationOptional<number | null>;
  declare decidedAt: CreationOptional<Date | null>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class PaymentGatewayConfig extends Model<
  InferAttributes<PaymentGatewayConfig>,
  InferCreationAttributes<PaymentGatewayConfig>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare gateway: PaymentGatewayKey;
  declare enabled: CreationOptional<boolean>;
  declare isDefault: CreationOptional<boolean>;
  declare merchantId: string | null;
  declare secretEncrypted: string | null;
  declare keyHint: string | null;
  declare sandbox: CreationOptional<boolean>;
  declare webhookKey: string;
  /** Uses the platform's global gateway credentials (super admin fallback), not the institute's. */
  declare platformManaged: CreationOptional<boolean>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class BankAccount extends Model<InferAttributes<BankAccount>, InferCreationAttributes<BankAccount>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number | null;
  declare name: string;
  declare bankName: string | null;
  declare accountNumberLast4: string | null;
  declare ifsc: string | null;
  declare openingBalance: CreationOptional<number>;
  declare active: CreationOptional<boolean>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeePayment extends Model<InferAttributes<FeePayment>, InferCreationAttributes<FeePayment>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number;
  declare accountId: number;
  declare studentId: number;
  declare amount: number;
  declare mode: FeePaymentMode;
  declare gateway: PaymentGatewayKey | null;
  declare status: CreationOptional<FeePaymentStatus>;
  declare approvalStatus: CreationOptional<FeeApprovalStatus>;
  declare referenceNo: string | null;
  declare chequeNumber: string | null;
  declare chequeDate: string | null;
  declare bankName: string | null;
  declare paidOn: string | null;
  declare gatewayOrderId: string | null;
  declare gatewayPaymentId: CreationOptional<string | null>;
  declare gatewayCharge: CreationOptional<number>;
  declare gatewayPayload: CreationOptional<unknown>;
  declare refunded: CreationOptional<number>;
  declare idempotencyKey: string | null;
  declare bankAccountId: number | null;
  declare receiptId: CreationOptional<number | null>;
  declare recordedByUserId: number | null;
  declare approvedByUserId: CreationOptional<number | null>;
  declare notes: string | null;
  declare postedAt: CreationOptional<Date | null>;
  /** Website coupon applied to this online order (redeemed on capture, released on refund). */
  declare couponCode: CreationOptional<string | null>;
  /** Discount granted by the coupon, in paise (applied to the account when the payment posts). */
  declare couponDiscount: CreationOptional<number>;
  declare referralCode: CreationOptional<string | null>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
  declare student?: NonAttribute<Student>;
  declare receipt?: NonAttribute<FeeReceipt>;
}

export class FeePaymentAllocation extends Model<
  InferAttributes<FeePaymentAllocation>,
  InferCreationAttributes<FeePaymentAllocation>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare paymentId: number;
  declare instalmentId: number;
  declare amount: number;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeReceipt extends Model<InferAttributes<FeeReceipt>, InferCreationAttributes<FeeReceipt>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number;
  declare number: string;
  declare invoiceNumber: string | null;
  declare paymentId: number;
  declare accountId: number;
  declare studentId: number;
  declare amount: number;
  declare taxableValue: CreationOptional<number>;
  declare cgst: CreationOptional<number>;
  declare sgst: CreationOptional<number>;
  declare igst: CreationOptional<number>;
  declare status: CreationOptional<'issued' | 'cancelled'>;
  declare pdfFileId: CreationOptional<number | null>;
  declare issuedAt: Date;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeRefund extends Model<InferAttributes<FeeRefund>, InferCreationAttributes<FeeRefund>> {
  declare id: Base['id'];
  declare instituteId: number;
  declare paymentId: number;
  declare amount: number;
  declare reason: string | null;
  declare reduceDues: CreationOptional<boolean>;
  declare status: CreationOptional<'pending' | 'processed' | 'failed'>;
  declare gatewayRefundId: CreationOptional<string | null>;
  declare idempotencyKey: string;
  declare requestedByUserId: number | null;
  declare processedAt: CreationOptional<Date | null>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeLedgerEntry extends Model<
  InferAttributes<FeeLedgerEntry>,
  InferCreationAttributes<FeeLedgerEntry>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number | null;
  declare journalKey: string;
  declare line: number;
  declare entryDate: string;
  declare account: string;
  declare debit: number;
  declare credit: number;
  declare feeAccountId: number | null;
  declare refType: string;
  declare refId: number | null;
  declare narration: string | null;
  declare createdByUserId: number | null;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FeeEntitlement extends Model<
  InferAttributes<FeeEntitlement>,
  InferCreationAttributes<FeeEntitlement>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare studentId: number;
  declare studentUserId: number | null;
  declare courseId: number | null;
  declare subjectId: number | null;
  declare accountId: number;
  declare grantedAt: Date;
  declare revokedAt: Date | null;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

/** Course-purchase enrolment queue; tenant data, exported and purged with the institute. */
export class FeeCourseEnrolment extends Model<
  InferAttributes<FeeCourseEnrolment>,
  InferCreationAttributes<FeeCourseEnrolment>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number;
  declare accountId: number;
  declare studentId: number;
  declare studentUserId: number | null;
  declare courseId: number;
  declare requestedBatchId: number | null;
  declare batchId: number | null;
  declare applicationId: number | null;
  declare status: FeeCourseEnrolmentStatus;
  declare addedToBatch: CreationOptional<boolean>;
  declare reason: CourseBatchIssue | null;
  declare enrolledAt: Date | null;
  declare revokedAt: Date | null;
  declare notifiedAt: CreationOptional<Date | null>;
  declare assignedByUserId: CreationOptional<number | null>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
  declare student?: NonAttribute<Student>;
}

export class FeeWebhookEvent extends Model<
  InferAttributes<FeeWebhookEvent>,
  InferCreationAttributes<FeeWebhookEvent>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare gateway: string;
  declare eventKey: string;
  declare gatewayOrderId: string | null;
  declare status: string;
  declare payload: unknown;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FinanceCategory extends Model<
  InferAttributes<FinanceCategory>,
  InferCreationAttributes<FinanceCategory>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare kind: FinanceEntryKind;
  declare name: string;
  declare active: CreationOptional<boolean>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export class FinanceEntry extends Model<
  InferAttributes<FinanceEntry>,
  InferCreationAttributes<FinanceEntry>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare branchId: number | null;
  declare kind: FinanceEntryKind;
  declare categoryId: number;
  declare entryDate: string;
  declare amount: number;
  declare tax: CreationOptional<number>;
  declare mode: OfflinePaymentMode;
  declare bankAccountId: number | null;
  declare party: string | null;
  declare reference: string | null;
  declare notes: string | null;
  declare attachmentFileId: number | null;
  declare status: CreationOptional<'recorded' | 'cancelled'>;
  declare recordedByUserId: number | null;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
  declare category?: NonAttribute<FinanceCategory>;
}

export class BankStatementLine extends Model<
  InferAttributes<BankStatementLine>,
  InferCreationAttributes<BankStatementLine>
> {
  declare id: Base['id'];
  declare instituteId: number;
  declare bankAccountId: number;
  declare txnDate: string;
  declare description: string | null;
  declare reference: string | null;
  declare amount: number;
  declare status: CreationOptional<'unmatched' | 'matched' | 'ignored'>;
  declare matchedType: CreationOptional<'payment' | 'finance_entry' | null>;
  declare matchedId: CreationOptional<number | null>;
  declare createdAt: Stamps['createdAt'];
  declare updatedAt: Stamps['updatedAt'];
}

export function initFeeModels(sequelize: Sequelize) {
  init(FeeSettingsRow, sequelize, 'fee_settings', { settings: J(false) });
  init(FeeHead, sequelize, 'fee_heads', {
    name: S(100, false),
    code: S(30, false),
    taxable: B(true),
    active: B(true),
    sortOrder: I(),
  });
  init(FeeStructure, sequelize, 'fee_structures', {
    branchId: OPT_FK(),
    familyId: OPT_FK(),
    version: I(1),
    kind: { ...S(10, false), defaultValue: 'course' },
    courseId: OPT_FK(),
    batchId: OPT_FK(),
    subjectId: OPT_FK(),
    academicSessionId: OPT_FK(),
    name: S(150, false),
    status: { ...S(10, false), defaultValue: 'active' },
    effectiveFrom: D(false),
    components: J(false),
    total: money('total'),
    instalmentPlan: J(false),
    createdByUserId: OPT_FK(),
  });
  init(FeeConcessionRule, sequelize, 'fee_concession_rules', {
    name: S(120, false),
    type: { ...S(15, false), defaultValue: 'concession' },
    mode: S(10, false),
    value: dec('value'),
    requiresApproval: B(true),
    active: B(true),
    description: S(500),
  });
  init(FeeAccount, sequelize, 'fee_accounts', {
    branchId: FK(),
    studentId: FK(),
    studentUserId: OPT_FK(),
    structureId: OPT_FK(),
    courseId: OPT_FK(),
    batchId: OPT_FK(),
    subjectId: OPT_FK(),
    academicSessionId: OPT_FK(),
    title: S(150, false),
    gross: money('gross'),
    taxableGross: money('taxableGross'),
    discount: money('discount'),
    charges: money('charges'),
    lateFee: money('lateFee'),
    paid: money('paid'),
    advance: money('advance'),
    status: { ...S(10, false), defaultValue: 'active' },
    source: { ...S(20, false), defaultValue: 'manual' },
    sourceRef: S(80),
  });
  init(FeeInstalment, sequelize, 'fee_instalments', {
    accountId: FK(),
    seq: I(1),
    label: S(60, false),
    dueDate: D(false),
    amount: money('amount'),
    lateFee: money('lateFee'),
    paid: money('paid'),
    status: { ...S(10, false), defaultValue: 'pending' },
    reminderSentAt: DT(),
    overdueNotifiedAt: DT(),
    lateFeeAppliedOn: D(),
  });
  init(FeeAdjustment, sequelize, 'fee_adjustments', {
    accountId: FK(),
    ruleId: OPT_FK(),
    type: S(15, false),
    mode: S(10, false),
    value: dec('value'),
    amount: money('amount'),
    reason: S(500),
    status: { ...S(10, false), defaultValue: 'pending' },
    requestedByUserId: OPT_FK(),
    decidedByUserId: OPT_FK(),
    decidedAt: DT(),
  });
  init(PaymentGatewayConfig, sequelize, 'payment_gateway_configs', {
    gateway: S(20, false),
    enabled: B(true),
    isDefault: B(false),
    merchantId: S(120),
    secretEncrypted: { type: DataTypes.TEXT, allowNull: true },
    keyHint: S(20),
    sandbox: B(true),
    webhookKey: S(64, false),
    platformManaged: B(false),
  });
  registerEncryptedColumns(PaymentGatewayConfig, ['secretEncrypted']);
  init(BankAccount, sequelize, 'bank_accounts', {
    branchId: OPT_FK(),
    name: S(120, false),
    bankName: S(120),
    accountNumberLast4: S(4),
    ifsc: S(15),
    openingBalance: money('openingBalance'),
    active: B(true),
  });
  init(FeePayment, sequelize, 'fee_payments', {
    branchId: FK(),
    accountId: FK(),
    studentId: FK(),
    amount: money('amount'),
    mode: S(15, false),
    gateway: S(20),
    status: { ...S(20, false), defaultValue: 'pending' },
    approvalStatus: { ...S(15, false), defaultValue: 'not_required' },
    referenceNo: S(120),
    chequeNumber: S(30),
    chequeDate: D(),
    bankName: S(120),
    paidOn: D(),
    gatewayOrderId: S(120),
    gatewayPaymentId: S(120),
    gatewayCharge: money('gatewayCharge'),
    gatewayPayload: J(),
    refunded: money('refunded'),
    idempotencyKey: S(120),
    bankAccountId: OPT_FK(),
    receiptId: OPT_FK(),
    recordedByUserId: OPT_FK(),
    approvedByUserId: OPT_FK(),
    notes: S(500),
    postedAt: DT(),
    couponCode: S(40),
    couponDiscount: money('couponDiscount'),
    referralCode: S(40),
  });
  init(FeePaymentAllocation, sequelize, 'fee_payment_allocations', {
    paymentId: FK(),
    instalmentId: FK(),
    amount: money('amount'),
  });
  init(FeeReceipt, sequelize, 'fee_receipts', {
    branchId: FK(),
    number: S(120, false),
    invoiceNumber: S(120),
    paymentId: FK(),
    accountId: FK(),
    studentId: FK(),
    amount: money('amount'),
    taxableValue: money('taxableValue'),
    cgst: money('cgst'),
    sgst: money('sgst'),
    igst: money('igst'),
    status: { ...S(10, false), defaultValue: 'issued' },
    pdfFileId: OPT_FK(),
    issuedAt: DT(false),
  });
  init(FeeRefund, sequelize, 'fee_refunds', {
    paymentId: FK(),
    amount: money('amount'),
    reason: S(500),
    reduceDues: B(true),
    status: { ...S(15, false), defaultValue: 'pending' },
    gatewayRefundId: S(120),
    idempotencyKey: S(120, false),
    requestedByUserId: OPT_FK(),
    processedAt: DT(),
  });
  init(FeeLedgerEntry, sequelize, 'fee_ledger_entries', {
    branchId: OPT_FK(),
    journalKey: S(120, false),
    line: I(1),
    entryDate: D(false),
    account: S(60, false),
    debit: money('debit'),
    credit: money('credit'),
    feeAccountId: OPT_FK(),
    refType: S(30, false),
    refId: OPT_FK(),
    narration: S(255),
    createdByUserId: OPT_FK(),
  });
  init(FeeEntitlement, sequelize, 'fee_entitlements', {
    studentId: FK(),
    studentUserId: OPT_FK(),
    courseId: OPT_FK(),
    subjectId: OPT_FK(),
    accountId: FK(),
    grantedAt: DT(false),
    revokedAt: DT(),
  });
  init(FeeCourseEnrolment, sequelize, 'fee_course_enrolments', {
    branchId: FK(),
    accountId: FK(),
    studentId: FK(),
    studentUserId: OPT_FK(),
    courseId: FK(),
    requestedBatchId: OPT_FK(),
    batchId: OPT_FK(),
    applicationId: OPT_FK(),
    status: S(20, false),
    addedToBatch: B(false),
    reason: S(30),
    enrolledAt: DT(),
    revokedAt: DT(),
    notifiedAt: DT(),
    assignedByUserId: OPT_FK(),
  });
  init(FeeWebhookEvent, sequelize, 'fee_webhook_events', {
    gateway: S(20, false),
    eventKey: S(160, false),
    gatewayOrderId: S(120),
    status: S(20, false),
    payload: J(),
  });
  init(FinanceCategory, sequelize, 'finance_categories', {
    kind: S(10, false),
    name: S(100, false),
    active: B(true),
  });
  init(FinanceEntry, sequelize, 'finance_entries', {
    branchId: OPT_FK(),
    kind: S(10, false),
    categoryId: FK(),
    entryDate: D(false),
    amount: money('amount'),
    tax: money('tax'),
    mode: S(15, false),
    bankAccountId: OPT_FK(),
    party: S(150),
    reference: S(120),
    notes: S(500),
    attachmentFileId: OPT_FK(),
    status: { ...S(10, false), defaultValue: 'recorded' },
    recordedByUserId: OPT_FK(),
  });
  init(BankStatementLine, sequelize, 'bank_statement_lines', {
    bankAccountId: FK(),
    txnDate: D(false),
    description: S(255),
    reference: S(120),
    amount: money('amount'),
    status: { ...S(10, false), defaultValue: 'unmatched' },
    matchedType: S(20),
    matchedId: OPT_FK(),
  });
}

export function associateFeeModels() {
  FeeAccount.belongsTo(Student, { foreignKey: 'studentId', as: 'student' });
  FeeAccount.hasMany(FeeInstalment, { foreignKey: 'accountId', as: 'instalments' });
  FeeInstalment.belongsTo(FeeAccount, { foreignKey: 'accountId', as: 'account' });
  FeePayment.belongsTo(Student, { foreignKey: 'studentId', as: 'student' });
  FeePayment.belongsTo(FeeReceipt, { foreignKey: 'receiptId', as: 'receipt', constraints: false });
  FeeCourseEnrolment.belongsTo(Student, { foreignKey: 'studentId', as: 'student' });
  FinanceEntry.belongsTo(FinanceCategory, { foreignKey: 'categoryId', as: 'category' });
}
