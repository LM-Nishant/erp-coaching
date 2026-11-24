import { actionSheetController } from '@ionic/vue';
import type { ReportExportFormat, ReportExportStatus } from '@erp/shared';
import { i18n } from '@/i18n';

export const formatLabel = (format: ReportExportFormat) => i18n.global.t(`reports.exports.formats.${format}`);

export const STATUS_TONES: Record<
  ReportExportStatus,
  'success' | 'warning' | 'danger' | 'primary' | 'medium'
> = {
  queued: 'medium',
  running: 'primary',
  ready: 'success',
  failed: 'danger',
  expired: 'medium',
};

/** Asks for an export format; null when cancelled. */
export async function pickExportFormat(
  header = i18n.global.t('reports.exports.exportAs'),
): Promise<ReportExportFormat | null> {
  const formats: ReportExportFormat[] = ['xlsx', 'pdf', 'csv'];
  const sheet = await actionSheetController.create({
    header,
    buttons: [
      ...formats.map((format) => ({ text: formatLabel(format), data: format })),
      { text: i18n.global.t('common.actions.cancel'), role: 'cancel' },
    ],
  });
  await sheet.present();
  const { data, role } = await sheet.onDidDismiss<ReportExportFormat>();
  return role === 'cancel' || role === 'backdrop' || !data ? null : data;
}
