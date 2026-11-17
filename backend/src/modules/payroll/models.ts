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
  ComponentSlab,
  PayType,
  PayrollRunStatus,
  PayslipLine,
  SettlementStatus,
  StructureItem,
  WorkUnitType,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { Employee, EmployeeSeparation } from '../hr/models';

const PK = () => ({ type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true });
const FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false });
const OPT_FK = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
const TS = () => ({ createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE });
const S = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const D = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
const JSONCOL = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });

/** DECIMAL/BIGINT columns may come back from mysql2 as strings; expose them as numbers. */
function num(name: string, type: DataTypes.DataType, allowNull: boolean, defaultValue?: number) {
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
const money = (name: string, allowNull = false) =>
  num(name, DataTypes.BIGINT, allowNull, allowNull ? undefined : 0);
const rate = (name: string) => num(name, DataTypes.DECIMAL(7, 3), true);

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

export class SalaryStructure extends Model<
  InferAttributes<SalaryStructure>,
  InferCreationAttributes<SalaryStructure>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare employeeId: number;
  declare payType: PayType;
  declare monthlyBasic: number;
  declare ratePerUnit: number;
  declare allowances: StructureItem[] | null;
  declare deductions: StructureItem[] | null;
  declare pfApplicable: CreationOptional<boolean>;
  declare esiApplicable: CreationOptional<boolean>;
  declare ptApplicable: CreationOptional<boolean>;
  declare tdsApplicable: CreationOptional<boolean>;
  /** Overrides the institute TDS component percentage for this employee. */
  declare tdsPercent: number | null;
  declare effectiveFrom: string;
  declare effectiveTo: string | null;
  declare notes: string | null;
  declare employee?: NonAttribute<Employee>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class PayrollComponent extends Model<
  InferAttributes<PayrollComponent>,
  InferCreationAttributes<PayrollComponent>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare code: string;
  declare name: string;
  declare kind: 'earning' | 'deduction';
  declare statutory: CreationOptional<boolean>;
  declare calcType: 'percent' | 'fixed' | 'slab';
  declare base: CreationOptional<'basic' | 'gross'>;
  declare employeeRate: number | null;
  declare employerRate: number | null;
  declare fixedAmount: number | null;
  declare wageCeiling: number | null;
  declare eligibilityMaxGross: number | null;
  declare slabs: ComponentSlab[] | null;
  declare effectiveFrom: string;
  declare effectiveTo: string | null;
  declare active: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class PayrollRun extends Model<InferAttributes<PayrollRun>, InferCreationAttributes<PayrollRun>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare periodYear: number;
  declare periodMonth: number;
  declare scopeKey: string;
  declare status: CreationOptional<PayrollRunStatus>;
  declare employeeCount: CreationOptional<number>;
  declare totalGross: CreationOptional<number>;
  declare totalDeductions: CreationOptional<number>;
  declare totalNet: CreationOptional<number>;
  declare totalEmployer: CreationOptional<number>;
  declare generatedAt: CreationOptional<Date | null>;
  declare approvedAt: CreationOptional<Date | null>;
  declare approvedBy: CreationOptional<number | null>;
  declare lockedAt: CreationOptional<Date | null>;
  declare lockedBy: CreationOptional<number | null>;
  declare notes: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class WorkUnit extends Model<InferAttributes<WorkUnit>, InferCreationAttributes<WorkUnit>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare employeeId: number;
  declare date: string;
  declare unitType: WorkUnitType;
  declare quantity: number;
  /** Incentive amount (paise); ignored for lecture/class units, which use the structure rate. */
  declare amount: CreationOptional<number>;
  declare description: string | null;
  declare referenceType: string | null;
  declare referenceId: string | null;
  declare source: CreationOptional<'manual' | 'api'>;
  declare externalRef: string | null;
  declare payrollRunId: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Payslip extends Model<InferAttributes<Payslip>, InferCreationAttributes<Payslip>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare payrollRunId: number;
  declare employeeId: number;
  declare salaryStructureId: number | null;
  declare periodYear: number;
  declare periodMonth: number;
  declare payType: PayType;
  declare daysInMonth: number;
  declare employedDays: number;
  declare lopDays: number;
  declare payableDays: number;
  declare attendance: Record<string, number> | null;
  declare units: { lecture: number; class: number } | null;
  declare lines: PayslipLine[];
  declare gross: number;
  declare totalDeductions: number;
  declare net: number;
  declare employerContributions: number;
  declare pdfFileId: CreationOptional<number | null>;
  declare employee?: NonAttribute<Employee>;
  declare run?: NonAttribute<PayrollRun>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class FinalSettlement extends Model<
  InferAttributes<FinalSettlement>,
  InferCreationAttributes<FinalSettlement>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare employeeId: number;
  declare separationId: number;
  declare lastWorkingDay: string;
  declare lines: PayslipLine[];
  declare net: number;
  declare status: CreationOptional<SettlementStatus>;
  declare notes: string | null;
  declare approvedBy: CreationOptional<number | null>;
  declare approvedAt: CreationOptional<Date | null>;
  declare paidAt: CreationOptional<Date | null>;
  declare employee?: NonAttribute<Employee>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initPayrollModels(sequelize: Sequelize) {
  init(SalaryStructure, sequelize, 'salary_structures', {
    employeeId: FK(),
    payType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'fixed_monthly' },
    monthlyBasic: money('monthlyBasic'),
    ratePerUnit: money('ratePerUnit'),
    allowances: JSONCOL(),
    deductions: JSONCOL(),
    pfApplicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    esiApplicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ptApplicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tdsApplicable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    tdsPercent: rate('tdsPercent'),
    effectiveFrom: D(false),
    effectiveTo: D(),
    notes: S(500),
  });
  init(PayrollComponent, sequelize, 'payroll_components', {
    code: S(30, false),
    name: S(100, false),
    kind: S(20, false),
    statutory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    calcType: S(20, false),
    base: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'basic' },
    employeeRate: rate('employeeRate'),
    employerRate: rate('employerRate'),
    fixedAmount: money('fixedAmount', true),
    wageCeiling: money('wageCeiling', true),
    eligibilityMaxGross: money('eligibilityMaxGross', true),
    slabs: JSONCOL(),
    effectiveFrom: D(false),
    effectiveTo: D(),
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  init(PayrollRun, sequelize, 'payroll_runs', {
    branchId: OPT_FK(),
    periodYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    periodMonth: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    scopeKey: S(20, false),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    employeeCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    totalGross: money('totalGross'),
    totalDeductions: money('totalDeductions'),
    totalNet: money('totalNet'),
    totalEmployer: money('totalEmployer'),
    generatedAt: { type: DataTypes.DATE, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    approvedBy: OPT_FK(),
    lockedAt: { type: DataTypes.DATE, allowNull: true },
    lockedBy: OPT_FK(),
    notes: S(500),
  });
  init(WorkUnit, sequelize, 'work_units', {
    employeeId: FK(),
    date: D(false),
    unitType: S(20, false),
    quantity: num('quantity', DataTypes.DECIMAL(8, 2), false, 0),
    amount: money('amount'),
    description: S(255),
    referenceType: S(50),
    referenceId: S(50),
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },
    externalRef: S(120),
    payrollRunId: OPT_FK(),
  });
  init(Payslip, sequelize, 'payslips', {
    branchId: OPT_FK(),
    payrollRunId: FK(),
    employeeId: FK(),
    salaryStructureId: OPT_FK(),
    periodYear: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    periodMonth: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    payType: S(20, false),
    daysInMonth: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    employedDays: num('employedDays', DataTypes.DECIMAL(5, 1), false),
    lopDays: num('lopDays', DataTypes.DECIMAL(5, 1), false, 0),
    payableDays: num('payableDays', DataTypes.DECIMAL(5, 1), false),
    attendance: JSONCOL(),
    units: JSONCOL(),
    lines: JSONCOL(false),
    gross: money('gross'),
    totalDeductions: money('totalDeductions'),
    net: money('net'),
    employerContributions: money('employerContributions'),
    pdfFileId: OPT_FK(),
  });
  init(FinalSettlement, sequelize, 'final_settlements', {
    employeeId: FK(),
    separationId: FK(),
    lastWorkingDay: D(false),
    lines: JSONCOL(false),
    net: money('net'),
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    notes: S(500),
    approvedBy: OPT_FK(),
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    paidAt: { type: DataTypes.DATE, allowNull: true },
  });
}

export function associatePayrollModels() {
  SalaryStructure.belongsTo(Employee, { as: 'employee', foreignKey: 'employeeId' });
  WorkUnit.belongsTo(Employee, { as: 'employee', foreignKey: 'employeeId' });
  Payslip.belongsTo(Employee, { as: 'employee', foreignKey: 'employeeId' });
  Payslip.belongsTo(PayrollRun, { as: 'run', foreignKey: 'payrollRunId' });
  PayrollRun.hasMany(Payslip, { as: 'payslips', foreignKey: 'payrollRunId' });
  FinalSettlement.belongsTo(Employee, { as: 'employee', foreignKey: 'employeeId' });
  FinalSettlement.belongsTo(EmployeeSeparation, { as: 'separation', foreignKey: 'separationId' });
}
