import type { FeeSettings } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { FeeSettingsRow } from './models';

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  receiptFormat: '{INST}/RCPT/{FY}/{SEQ:5}',
  invoiceFormat: '{INST}/INV/{FY}/{SEQ:5}',
  gstEnabled: false,
  gstin: null,
  gstRatePercent: 18,
  gstInclusive: true,
  gstInterState: false,
  sacCode: '999293',
  lateFee: { type: 'none', amount: 0, percent: 0, graceDays: 0, maxAmount: null },
  reminderDaysBefore: 3,
  offlineApprovalRequired: false,
  concessionApprovalThreshold: 0,
  entitlementAfterInstalment: 1,
};

export async function getFeeSettings(): Promise<FeeSettings> {
  const { instituteId } = requireTenantContext();
  const row = await FeeSettingsRow.findOne({ where: { instituteId } });
  const s = (row?.settings ?? {}) as Partial<FeeSettings>;
  return {
    ...DEFAULT_FEE_SETTINGS,
    ...s,
    lateFee: { ...DEFAULT_FEE_SETTINGS.lateFee, ...(s.lateFee ?? {}) },
  };
}

export async function updateFeeSettings(
  patch: Partial<FeeSettings>,
): Promise<{ before: FeeSettings; after: FeeSettings }> {
  const { instituteId } = requireTenantContext();
  const before = await getFeeSettings();
  const after: FeeSettings = {
    ...before,
    ...patch,
    lateFee: { ...before.lateFee, ...(patch.lateFee ?? {}) },
  };
  const row = await FeeSettingsRow.findOne({ where: { instituteId } });
  if (row) await row.update({ settings: after });
  else await FeeSettingsRow.create({ instituteId, settings: after });
  return { before, after };
}
