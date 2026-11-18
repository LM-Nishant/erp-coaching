import type { ReportExportFormat } from '@erp/shared';
import { renderCsv } from './csv';
import type { RenderMeta, ReportDocument } from './meta';
import { renderPdf } from './pdf';
import { renderXlsx } from './xlsx';

export type { RenderMeta, ReportDocument } from './meta';

export const EXPORT_MIME_TYPES: Record<ReportExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export interface RenderedReport {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

/** `fee-collections-2026-01-01-to-2026-01-31.xlsx` */
export function exportFileName(
  result: Pick<ReportDocument, 'key' | 'period'>,
  format: ReportExportFormat,
): string {
  return `${result.key}-${result.period.from}-to-${result.period.to}.${format}`;
}

export function renderReport(
  result: ReportDocument,
  format: ReportExportFormat,
  meta: RenderMeta,
): RenderedReport {
  const buffer =
    format === 'csv'
      ? renderCsv(result)
      : format === 'xlsx'
        ? renderXlsx(result, meta)
        : renderPdf(result, meta);
  return { buffer, mimeType: EXPORT_MIME_TYPES[format], fileName: exportFileName(result, format) };
}
