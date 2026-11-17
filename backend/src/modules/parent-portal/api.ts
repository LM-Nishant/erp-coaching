import type { ParentChildDto, ParentPortalSectionDto } from '@erp/shared';

/** Reporting window passed to `monthlyReport` providers. Dates are inclusive `YYYY-MM-DD`. */
export interface ParentReportPeriod {
  /** `YYYY-MM`. */
  period: string;
  from: string;
  to: string;
}

/**
 * A data source for the parent portal (spec §4.12). Feature modules register one from their
 * `integrations.ts` (`onReady`) — e.g. fees dues, attendance %, latest results, pending homework.
 *
 * Providers run inside the institute's tenant context (as the parent for `summary`, as a system
 * context for `monthlyReport`), receive an actively-linked child, and return `null` when they have
 * nothing to show. A throwing provider is logged and skipped; it never breaks the dashboard.
 */
export interface ParentPortalProvider {
  /** Unique key, usually the module name (`fees`, `attendance`…). */
  key: string;
  label: string;
  /** Sort order on the dashboard/report (lower first). Default 100. */
  order?: number;
  /** Plan module that must be enabled for the institute; defaults to `key`. `null` = always. */
  module?: string | null;
  /** Live section for the parent home "Summary" card. */
  summary?: (child: ParentChildDto) => Promise<ParentPortalSectionDto | null>;
  /** Section for the monthly parent report. */
  monthlyReport?: (
    child: ParentChildDto,
    period: ParentReportPeriod,
  ) => Promise<ParentPortalSectionDto | null>;
}

const providers = new Map<string, ParentPortalProvider>();

/** Registers (or replaces, by key) a parent portal provider. */
export function registerParentPortalProvider(provider: ParentPortalProvider): void {
  providers.set(provider.key, provider);
}

export function listParentPortalProviders(): ParentPortalProvider[] {
  return [...providers.values()].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.key.localeCompare(b.key),
  );
}

/** Test helper. */
export function unregisterParentPortalProvider(key: string): void {
  providers.delete(key);
}

export type { ParentChildDto, ParentPortalSectionDto };
