import { actionSheetController } from '@ionic/vue';
import type { ReportExportFormat, ReportExportStatus } from '@erp/shared';

export const FORMAT_LABELS: Record<ReportExportFormat, string> = {
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF',
  csv: 'CSV',
};

export const STATUS_COLORS: Record<ReportExportStatus, string> = {
  queued: 'medium',
  running: 'primary',
  ready: 'success',
  failed: 'danger',
  expired: 'medium',
};

/** Asks for an export format; null when cancelled. */
export async function pickExportFormat(header = 'Export as'): Promise<ReportExportFormat | null> {
  const formats: ReportExportFormat[] = ['xlsx', 'pdf', 'csv'];
  const sheet = await actionSheetController.create({
    header,
    buttons: [
      ...formats.map((format) => ({ text: FORMAT_LABELS[format], data: format })),
      { text: 'Cancel', role: 'cancel' },
    ],
  });
  await sheet.present();
  const { data, role } = await sheet.onDidDismiss<ReportExportFormat>();
  return role === 'cancel' || role === 'backdrop' || !data ? null : data;
}
