import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type ModelAttributes,
  type Sequelize,
} from 'sequelize';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

const PK = () => ({ type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true });
const FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false });
const OPT_FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
const S = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const J = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });
const SCOPE = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const INT = () => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
/** BIGINT paise come back from mysql2 as strings; expose them as numbers. */
const money = (name: string) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  defaultValue: 0,
  get(this: Model) {
    const v = this.getDataValue(name);
    return v == null ? 0 : Number(v);
  },
});

type AnyModelStatic = {
  init: (attrs: ModelAttributes, opts: { sequelize: Sequelize; tableName: string }) => unknown;
};
function init(model: unknown, sequelize: Sequelize, tableName: string, attrs: ModelAttributes) {
  (model as AnyModelStatic).init(
    { id: PK(), instituteId: FK(), branchId: OPT_FK(), ...attrs },
    { sequelize, tableName },
  );
  registerTenantModel(model as never);
}

export type TallyVoucherStatus = 'exported' | 'skipped' | 'previous';

/** One Tally ledger line as exported: positive = debit, negative = credit (paise). */
export interface TallyLineJson {
  ledger: string;
  amount: number;
}

export interface TallyMasterJson {
  name: string;
  parent: string;
  /** GST duty head for split output-tax ledgers. */
  gstDutyHead?: string | null;
}

export interface TallyTotalJson {
  ledger: string;
  parent: string;
  debit: number;
  credit: number;
}

export class TallySettingsRow extends Model<
  InferAttributes<TallySettingsRow>,
  InferCreationAttributes<TallySettingsRow>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare branchScope: number;
  declare companyName: string | null;
  declare receivableMode: string | null;
  declare gstLedgers: string | null;
  declare voucherTypes: unknown;
  declare updatedByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class TallyLedgerMapping extends Model<
  InferAttributes<TallyLedgerMapping>,
  InferCreationAttributes<TallyLedgerMapping>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare branchScope: number;
  declare account: string;
  declare tallyName: string;
  declare parentGroup: string;
  declare updatedByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class TallyKnownLedger extends Model<
  InferAttributes<TallyKnownLedger>,
  InferCreationAttributes<TallyKnownLedger>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare branchScope: number;
  declare kind: string;
  declare name: string;
  declare parent: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class TallyExport extends Model<InferAttributes<TallyExport>, InferCreationAttributes<TallyExport>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare fromDate: string;
  declare toDate: string;
  declare onlyNew: CreationOptional<boolean>;
  declare companyName: string | null;
  declare receivableMode: CreationOptional<string>;
  declare voucherCount: CreationOptional<number>;
  declare skippedCount: CreationOptional<number>;
  declare alreadyExportedCount: CreationOptional<number>;
  declare ledgerCount: CreationOptional<number>;
  declare totalAmount: CreationOptional<number>;
  declare totals: unknown;
  declare typeCounts: unknown;
  declare masters: unknown;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class TallyExportVoucher extends Model<
  InferAttributes<TallyExportVoucher>,
  InferCreationAttributes<TallyExportVoucher>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare exportId: number;
  declare journalKey: string;
  declare refType: string;
  declare refId: number | null;
  declare entryDate: string;
  declare voucherType: string;
  declare voucherNumber: string | null;
  declare remoteId: string;
  declare partyLedger: string | null;
  declare narration: string | null;
  declare lines: unknown;
  declare amount: CreationOptional<number>;
  declare fingerprint: string;
  declare contentDigest: string;
  /** `exported`, `skipped` (nets to zero in Tally) or `previous` (left out of an "only new" batch). */
  declare status: CreationOptional<TallyVoucherStatus>;
  declare skipReason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initTallyModels(sequelize: Sequelize) {
  init(TallySettingsRow, sequelize, 'tally_settings', {
    branchScope: SCOPE(),
    companyName: S(150),
    receivableMode: S(10),
    gstLedgers: S(10),
    voucherTypes: J(),
    updatedByUserId: OPT_FK(),
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });
  init(TallyLedgerMapping, sequelize, 'tally_ledger_mappings', {
    branchScope: SCOPE(),
    account: S(60, false),
    tallyName: S(100, false),
    parentGroup: S(100, false),
    updatedByUserId: OPT_FK(),
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });
  init(TallyKnownLedger, sequelize, 'tally_known_ledgers', {
    branchScope: SCOPE(),
    kind: S(10, false),
    name: S(200, false),
    parent: S(200),
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });
  init(TallyExport, sequelize, 'tally_exports', {
    fromDate: { type: DataTypes.DATEONLY, allowNull: false },
    toDate: { type: DataTypes.DATEONLY, allowNull: false },
    onlyNew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    companyName: S(150),
    receivableMode: { ...S(10, false), defaultValue: 'control' },
    voucherCount: INT(),
    skippedCount: INT(),
    alreadyExportedCount: INT(),
    ledgerCount: INT(),
    totalAmount: money('totalAmount'),
    totals: J(),
    typeCounts: J(),
    masters: J(),
    createdByUserId: OPT_FK(),
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });
  init(TallyExportVoucher, sequelize, 'tally_export_vouchers', {
    exportId: FK(),
    journalKey: S(120, false),
    refType: S(30, false),
    refId: OPT_FK(),
    entryDate: { type: DataTypes.DATEONLY, allowNull: false },
    voucherType: S(60, false),
    voucherNumber: S(60),
    remoteId: S(64, false),
    partyLedger: S(200),
    narration: S(500),
    lines: J(false),
    amount: money('amount'),
    fingerprint: { type: DataTypes.CHAR(64), allowNull: false },
    contentDigest: { type: DataTypes.CHAR(64), allowNull: false },
    status: { ...S(10, false), defaultValue: 'exported' },
    skipReason: S(120),
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  });
}

export function associateTallyModels() {
  TallyExport.hasMany(TallyExportVoucher, { foreignKey: 'exportId', as: 'vouchers' });
  TallyExportVoucher.belongsTo(TallyExport, { foreignKey: 'exportId', as: 'export' });
}
