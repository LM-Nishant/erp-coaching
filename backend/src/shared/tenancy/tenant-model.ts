import { Op } from 'sequelize';
import type { ModelStatic, Model, WhereOptions } from 'sequelize';
import { getContext } from '../context';

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

type Values = Record<string, unknown>;

function institutesIn(source: Values | undefined): unknown[] {
  if (!source || typeof source !== 'object') return [];
  const out: unknown[] = [];
  for (const key of ['instituteId', 'institute_id']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out.push(source[key]);
  }
  return out;
}

function whereHasInstitute(where: WhereOptions | undefined): boolean {
  return institutesIn(where as Values | undefined).length > 0;
}

/** Concrete institute ids named by a where value (`5`, `[5]`, `{ [Op.eq]: 5 }`, `{ [Op.in]: [5] }`). */
function concreteIds(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(concreteIds);
  if (value && typeof value === 'object') {
    const ops = value as Record<symbol, unknown>;
    return [...concreteIds(ops[Op.eq]), ...concreteIds(ops[Op.in])];
  }
  return value === undefined ? [] : [value];
}

/**
 * Safety net: marks a model as tenant-owned and installs hooks that
 * - reject any find/count/bulk update/bulk destroy without an `instituteId` condition, and
 * - reject any write (create, save, bulk create, upsert, update, destroy) whose `instituteId`
 *   differs from the current context's institute (system jobs bind one too).
 * Use `TenantRepository` in services so the condition is added automatically. Platform code
 * that legitimately works across institutes passes `tenantBypass`.
 */
export function registerTenantModel<M extends Model>(
  model: ModelStatic<M>,
  options: TenantModelOptions = {},
): void {
  const key = model as unknown as ModelStatic<Model>;
  TENANT_MODELS.set(key, { model: key, retainOnInstituteDeletion: !!options.retainOnInstituteDeletion });

  const fail = (message: string): never => {
    throw new Error(`Tenant guard: ${model.name}.${message}`);
  };
  /** Throws when a written institute id is not the context's institute. */
  const sameTenant = (operation: string, ids: unknown[], opts: object) => {
    if ((opts as TenantBypassOption).tenantBypass) return;
    const current = getContext().instituteId;
    if (!current) return;
    for (const id of ids) {
      if (id === null || id === undefined) continue;
      if (Number(id) !== current) {
        fail(`${operation} for another institute (${String(id)}) in institute ${current}'s context`);
      }
    }
  };
  const guard =
    (operation: string, write = false) =>
    (options: object): void => {
      const opts = options as { where?: WhereOptions; attributes?: Values } & TenantBypassOption;
      if (opts.tenantBypass) return;
      if (!whereHasInstitute(opts.where)) {
        fail(
          `${operation} without instituteId. Use TenantRepository or pass tenantBypass for platform code.`,
        );
      }
      if (write) {
        const ids = institutesIn(opts.where as Values).flatMap(concreteIds);
        sameTenant(operation, [...ids, ...institutesIn(opts.attributes)], opts);
      }
    };
  const instanceIds = (instance: Model): unknown[] => {
    const ids = institutesIn((instance as unknown as { dataValues: Values }).dataValues);
    if (!instance.isNewRecord) {
      for (const k of ['instituteId', 'institute_id']) {
        if (instance.changed(k as never)) ids.push(instance.previous(k as never));
      }
    }
    return ids;
  };

  model.addHook('beforeFind', guard('find'));
  model.addHook('beforeCount', guard('count'));
  model.addHook('beforeBulkUpdate', guard('update', true));
  model.addHook('beforeBulkDestroy', guard('destroy', true));
  model.addHook('beforeSave', (instance: Model, opts: object) =>
    sameTenant(instance.isNewRecord ? 'create' : 'save', instanceIds(instance), opts),
  );
  model.addHook('beforeDestroy', (instance: Model, opts: object) =>
    sameTenant('destroy', instanceIds(instance), opts),
  );
  model.addHook('beforeBulkCreate', (instances: Model[], opts: object) =>
    sameTenant('bulkCreate', instances.flatMap(instanceIds), opts),
  );
  model.addHook('beforeUpsert', (values: object, opts: object) =>
    sameTenant('upsert', institutesIn(values as Values), opts),
  );
}

export function isTenantModel(model: object): boolean {
  return TENANT_MODELS.has(model as ModelStatic<Model>);
}

/** Every registered tenant-owned model (each module's tables), in registration order. */
export function listTenantModels(): TenantModelEntry[] {
  return [...TENANT_MODELS.values()];
}
