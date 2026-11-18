import type { ReportResultDto } from '@erp/shared';

/** What the renderers print: a report result, or a document of the same shape (the SaaS export). */
export type ReportDocument = Omit<ReportResultDto, 'key'> & { key: string };

/** Context printed on exported reports. */
export interface RenderMeta {
  instituteName: string;
}

/** `Branch: Main · Course: JEE · Batch: A1`, or `None`. */
export function filterSummary(result: ReportDocument): string {
  const f = result.filters;
  const parts = [
    f.branchName && `Branch: ${f.branchName}`,
    f.courseName && `Course: ${f.courseName}`,
    f.batchName && `Batch: ${f.batchName}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'None';
}
