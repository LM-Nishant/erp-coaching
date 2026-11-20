import type {
  MeDto,
  Paginated,
  TallyExportDetailDto,
  TallyExportDto,
  TallyExportRequest,
  TallyKnownLedgersDto,
  TallyLedgerImportResult,
  TallyMappingDto,
  TallyMappingItemDto,
  TallyMappingUpdate,
  TallyPreviewDto,
  TallyReconciliationDto,
  TallyReconFlag,
  TallySettingsDto,
  TallySettingsUpdate,
} from '@erp/shared';
import { api } from '@/core/api';
import { saveFile } from '@/core/downloads';

/** Branch scope: `'all'` = institute-wide (all branches), otherwise a branch id as text (ion-select values). */
export type ScopeKey = 'all' | `${number}`;
export interface ScopeOption {
  key: ScopeKey;
  label: string;
}

const query = (scope?: ScopeKey) => ({ branchId: scope });
const branchOf = (scope?: ScopeKey): number | null | undefined =>
  scope === undefined ? undefined : scope === 'all' ? null : Number(scope);

/**
 * Scopes the user can work with. A selected branch (branch switcher) is the only choice; institute-level users
 * also get "All branches", which holds the institute-wide settings and exports.
 */
export function scopeOptions(me: MeDto | null, activeBranchId: number | null): ScopeOption[] {
  if (!me) return [];
  const option = (b: { id: number; name: string }): ScopeOption => ({ key: `${b.id}`, label: b.name });
  if (activeBranchId) {
    const branch = me.branches.find((b) => b.id === activeBranchId);
    return [option(branch ?? { id: activeBranchId, name: `Branch ${activeBranchId}` })];
  }
  const allowed = me.allowedBranchIds;
  if (allowed === null)
    return [{ key: 'all', label: 'All branches (institute)' }, ...me.branches.map(option)];
  return me.branches.filter((b) => allowed.includes(b.id)).map(option);
}

/** An edited row of the mapping table. `reset`: remove this level's override. */
export interface MappingDraft {
  tallyName: string;
  parentGroup: string;
  reset: boolean;
}

export const draftOf = (item: TallyMappingItemDto): MappingDraft => ({
  tallyName: item.tallyName,
  parentGroup: item.parentGroup,
  reset: false,
});

/**
 * The overrides to save for one level: edited rows, plus removals of overrides stored at this level (reset, a
 * blank name, or the inherited values typed back in).
 */
export function mappingChanges(
  items: TallyMappingItemDto[],
  drafts: Record<string, MappingDraft>,
  level: 'branch' | 'institute',
): TallyMappingUpdate['items'] {
  const out: TallyMappingUpdate['items'] = [];
  for (const item of items) {
    const draft = drafts[item.account];
    if (!draft) continue;
    const name = draft.tallyName.trim();
    const group = draft.parentGroup.trim();
    const inherit =
      draft.reset || !name || (name === item.inheritedName && (!group || group === item.inheritedGroup));
    if (inherit) {
      if (item.source === level) out.push({ account: item.account, tallyName: null });
    } else if (name !== item.tallyName || group !== item.parentGroup) {
      out.push({ account: item.account, tallyName: name, parentGroup: group || null });
    }
  }
  return out;
}

export const FLAG_LABELS: Record<TallyReconFlag, string> = {
  new: 'Recorded after the export',
  changed: 'Changed since the export',
  removed: 'Removed from the app',
  reversed: 'Refunded or cancelled later',
  mapping: 'Ledger mapping changed',
};

export const SOURCE_LABELS: Record<TallyMappingItemDto['source'], string> = {
  branch: 'Branch',
  institute: 'Institute',
  default: 'Default',
};

export const tallyApi = {
  settings: (scope?: ScopeKey) => api.get<TallySettingsDto>('/tally/settings', query(scope)),
  saveSettings: (scope: ScopeKey | undefined, body: Omit<TallySettingsUpdate, 'branchId'>) =>
    api.put<TallySettingsDto>('/tally/settings', { ...body, branchId: branchOf(scope) }),
  mapping: (scope?: ScopeKey) => api.get<TallyMappingDto>('/tally/mappings', query(scope)),
  saveMapping: (scope: ScopeKey | undefined, items: TallyMappingUpdate['items']) =>
    api.put<TallyMappingDto>('/tally/mappings', { branchId: branchOf(scope), items }),
  knownLedgers: (scope?: ScopeKey, search?: string) =>
    api.get<TallyKnownLedgersDto>('/tally/known-ledgers', { ...query(scope), search }),
  importLedgers: (scope: ScopeKey | undefined, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return api.post<TallyLedgerImportResult>('/tally/known-ledgers', form, { query: query(scope) });
  },
  clearLedgers: (scope?: ScopeKey) =>
    api.delete<{ deleted: number }>('/tally/known-ledgers', { query: query(scope) }),
  preview: (scope: ScopeKey | undefined, q: Omit<TallyExportRequest, 'branchId'>) =>
    api.get<TallyPreviewDto>('/tally/preview', {
      ...query(scope),
      from: q.from,
      to: q.to,
      onlyNew: q.onlyNew ? 'true' : undefined,
    }),
  createExport: (scope: ScopeKey | undefined, body: Omit<TallyExportRequest, 'branchId'>) =>
    api.post<TallyExportDto>('/tally/exports', { ...body, branchId: branchOf(scope) }),
  /** Every batch the user can see (all branches for institute-level users), newest first. */
  exports: (page = 1, pageSize = 20) =>
    api.get<Paginated<TallyExportDto>>('/tally/exports', { page, pageSize }),
  export: (id: number) => api.get<TallyExportDetailDto>(`/tally/exports/${id}`),
  reconciliation: (id: number) => api.get<TallyReconciliationDto>(`/tally/exports/${id}/reconciliation`),
};

/**
 * Saves an export file for import in Tally: a browser download, or the share sheet on a device.
 * Returns the toast to show, or null when the share sheet handled (or the user cancelled) it.
 */
export async function downloadTallyFile(id: number, kind: 'masters' | 'vouchers'): Promise<string | null> {
  const file = await api.download(`/tally/exports/${id}/${kind}.xml`);
  const name = file.fileName ?? `tally-${id}-${kind}.xml`;
  return (await saveFile(file.blob, name)) === 'downloaded' ? `Downloaded ${name}` : null;
}

/** "1 Feb 2032 – 29 Feb 2032" */
export function periodLabel(e: { from: string; to: string }): string {
  const day = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  return `${day(e.from)} – ${day(e.to)}`;
}

export const formatDateTime = (at: string) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Journal 4 · Receipt 2 · Payment 1" */
export const typeSummary = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([type, n]) => `${type} ${n}`)
    .join(' · ');
