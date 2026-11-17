import {
  Op,
  type Attributes,
  type CreationAttributes,
  type FindOptions,
  type Model,
  type ModelStatic,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import { requireTenantContext } from '../context';
import { Forbidden, NotFound } from '../errors';

interface RepoOptions {
  /** Model has a `branchId` attribute and rows must be limited to the user's allowed branches. */
  branchScoped?: boolean;
  /** Human-readable entity name for errors. */
  entity?: string;
}

type TenantAttrs = { instituteId: number; branchId?: number | null };

/**
 * Data access for tenant-owned models. Every query is constrained to the institute (and, for
 * branch-scoped models, the allowed branches) from the authenticated context. Client-supplied
 * `instituteId` values are always overwritten.
 */
export class TenantRepository<M extends Model> {
  constructor(
    public readonly model: ModelStatic<M>,
    private readonly opts: RepoOptions = {},
  ) {}

  private get entity() {
    return this.opts.entity ?? this.model.name;
  }

  /** Builds the scoped `where` for the current context. */
  scope(where: WhereOptions<Attributes<M>> = {}): WhereOptions<Attributes<M>> {
    const ctx = requireTenantContext();
    const scoped: Record<string | symbol, unknown> = { ...(where as object), instituteId: ctx.instituteId };
    if (this.opts.branchScoped) {
      const allowed = ctx.activeBranchId ? [ctx.activeBranchId] : ctx.allowedBranchIds;
      if (allowed !== null) {
        const requested = (where as Record<string, unknown>).branchId;
        scoped.branchId =
          requested !== undefined
            ? {
                [Op.and]: [
                  requested !== null && typeof requested === 'object' ? requested : { [Op.eq]: requested },
                  { [Op.in]: allowed },
                ],
              }
            : { [Op.in]: allowed };
      }
    }
    return scoped as WhereOptions<Attributes<M>>;
  }

  assertBranchAllowed(branchId: number | null | undefined): void {
    if (!this.opts.branchScoped || branchId == null) return;
    const ctx = requireTenantContext();
    if (ctx.allowedBranchIds !== null && !ctx.allowedBranchIds.includes(branchId)) {
      throw Forbidden('You do not have access to this branch', 'BRANCH_FORBIDDEN');
    }
  }

  findAll(options: FindOptions<Attributes<M>> = {}) {
    return this.model.findAll({ ...options, where: this.scope(options.where) });
  }

  findAndCountAll(options: FindOptions<Attributes<M>> = {}) {
    return this.model.findAndCountAll({ ...options, where: this.scope(options.where), distinct: true });
  }

  findOne(options: FindOptions<Attributes<M>> = {}) {
    return this.model.findOne({ ...options, where: this.scope(options.where) });
  }

  count(where: WhereOptions<Attributes<M>> = {}) {
    return this.model.count({ where: this.scope(where) });
  }

  async findById(id: number, options: FindOptions<Attributes<M>> = {}): Promise<M> {
    const row = await this.findOne({
      ...options,
      where: { ...(options.where as object), id } as unknown as WhereOptions<Attributes<M>>,
    });
    if (!row) throw NotFound(this.entity);
    return row;
  }

  async create(values: Omit<CreationAttributes<M>, 'instituteId'>, opts: { transaction?: Transaction } = {}) {
    const ctx = requireTenantContext();
    const data = { ...(values as object), instituteId: ctx.instituteId } as CreationAttributes<M> &
      TenantAttrs;
    if (this.opts.branchScoped) {
      if (data.branchId == null && ctx.activeBranchId) data.branchId = ctx.activeBranchId;
      this.assertBranchAllowed(data.branchId);
    }
    return this.model.create(data, opts);
  }

  async update(id: number, values: Partial<Attributes<M>>, opts: { transaction?: Transaction } = {}) {
    const row = await this.findById(id, { transaction: opts.transaction });
    const data = { ...values } as Partial<TenantAttrs>;
    delete data.instituteId;
    if (this.opts.branchScoped && data.branchId !== undefined) this.assertBranchAllowed(data.branchId);
    return row.update(data as Partial<Attributes<M>>, opts);
  }

  async destroy(id: number, opts: { transaction?: Transaction } = {}) {
    const row = await this.findById(id, { transaction: opts.transaction });
    await row.destroy(opts);
    return row;
  }
}
