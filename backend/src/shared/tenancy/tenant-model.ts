import type { ModelStatic, Model, WhereOptions } from 'sequelize';

/** Pass `{ tenantBypass: true }` in query options ONLY for audited platform (super admin) or system code. */
export interface TenantBypassOption {
  tenantBypass?: boolean;
}

const TENANT_MODELS = new WeakSet<object>();

function whereHasInstitute(where: WhereOptions | undefined): boolean {
  if (!where || typeof where !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(where, 'instituteId') ||
    Object.prototype.hasOwnProperty.call(where, 'institute_id');
}

/**
 * Safety net: marks a model as tenant-owned and installs hooks that reject any find/count/bulk
 * update/bulk destroy without an `instituteId` condition. Use `TenantRepository` in services so
 * the condition is added automatically.
 */
export function registerTenantModel<M extends Model>(model: ModelStatic<M>): void {
  TENANT_MODELS.add(model);
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
  return TENANT_MODELS.has(model);
}
