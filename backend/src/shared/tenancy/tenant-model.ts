import type { ModelStatic, Model, WhereOptions } from 'sequelize';

/** Pass `{ tenantBypass: true }` in query options ONLY for audited platform (super admin) or system code. */
export interface TenantBypassOption {
  tenantBypass?: boolean;
}

export interface TenantModelOptions {
  /**
   * Keep the rows when the institute is permanently deleted (their `institute_id` FK must be
   * `SET NULL`), e.g. the operator's SaaS invoices that tax law requires it to retain.
   */
  retainOnInstituteDeletion?: boolean;
}

export interface TenantModelEntry {
  model: ModelStatic<Model>;
  retainOnInstituteDeletion: boolean;
}

// Enumerable (not a WeakSet) so institute export and deletion cover every module's tables.
const TENANT_MODELS = new Map<ModelStatic<Model>, TenantModelEntry>();

function whereHasInstitute(where: WhereOptions | undefined): boolean {
  if (!where || typeof where !== 'object') return false;
  return (
    Object.prototype.hasOwnProperty.call(where, 'instituteId') ||
    Object.prototype.hasOwnProperty.call(where, 'institute_id')
  );
}

/**
 * Safety net: marks a model as tenant-owned and installs hooks that reject any find/count/bulk
 * update/bulk destroy without an `instituteId` condition. Use `TenantRepository` in services so
 * the condition is added automatically.
 */
export function registerTenantModel<M extends Model>(
  model: ModelStatic<M>,
  options: TenantModelOptions = {},
): void {
  const key = model as unknown as ModelStatic<Model>;
  TENANT_MODELS.set(key, { model: key, retainOnInstituteDeletion: !!options.retainOnInstituteDeletion });
  const guard = (operation: string) => (options: { where?: WhereOptions } & TenantBypassOption) => {
    if (options.tenantBypass) return;
    if (!whereHasInstitute(options.where)) {
      throw new Error(
        `Tenant guard: ${model.name}.${operation} without instituteId. Use TenantRepository or pass tenantBypass for platform code.`,
      );
    }
  };
  model.addHook('beforeFind', guard('find'));
  model.addHook('beforeCount', guard('count'));
  model.addHook('beforeBulkUpdate', guard('update'));
  model.addHook('beforeBulkDestroy', guard('destroy'));
}

export function isTenantModel(model: object): boolean {
  return TENANT_MODELS.has(model as ModelStatic<Model>);
}

/** Every registered tenant-owned model (each module's tables), in registration order. */
export function listTenantModels(): TenantModelEntry[] {
  return [...TENANT_MODELS.values()];
}
