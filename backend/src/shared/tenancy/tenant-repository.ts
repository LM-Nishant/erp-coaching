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
import { AppError, Forbidden, NotFound } from '../errors';

interface RepoOptions {
  /** Model has a `branchId` attribute and rows must be limited to the user's allowed branches. */
  branchScoped?: boolean;
  /**
   * With `branchScoped`: rows with `branchId = NULL` are institute-wide and readable by every user
   * of the institute. Branch-restricted users cannot create, update or delete them.
   */
  instituteWideRows?: boolean;
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
        const visible = this.opts.instituteWideRows
          ? { [Op.or]: [{ [Op.in]: allowed }, { [Op.is]: null }] }
          : { [Op.in]: allowed };
        const requestedCond =
          requested === null
            ? { [Op.is]: null }
            : requested !== null && typeof requested === 'object'
              ? requested
              : { [Op.eq]: requested };
        scoped.branchId = requested !== undefined ? { [Op.and]: [requestedCond, visible] } : visible;
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

  /** Throws unless the current user may modify this row (institute-wide rows need institute-wide access). */
  assertRowWritable(row: M): void {
    this.assertBranchAssignable((row as unknown as TenantAttrs).branchId ?? null);
  }

  /** Throws unless the current user may put a row in `branchId` (null = institute-wide; undefined = unchanged). */
  assertBranchAssignable(branchId: number | null | undefined): void {
    if (!this.opts.branchScoped || branchId === undefined) return;
    if (branchId === null) {
      if (requireTenantContext().allowedBranchIds !== null)
        throw Forbidden(
          'Institute-wide records can only be changed by institute-level users',
          'BRANCH_FORBIDDEN',
        );
      return;
    }
    this.assertBranchAllowed(branchId);
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
      if (data.branchId == null && ctx.allowedBranchIds !== null) {
        // Branch-restricted users always create branch rows; default to their only branch.
        if (ctx.allowedBranchIds.length !== 1)
          throw new AppError(400, 'BRANCH_REQUIRED', 'Select a branch (X-Branch-Id or branchId)');
        data.branchId = ctx.allowedBranchIds[0];
      }
      this.assertBranchAllowed(data.branchId);
    }
    return this.model.create(data, opts);
  }

  async update(id: number, values: Partial<Attributes<M>>, opts: { transaction?: Transaction } = {}) {
    const row = await this.findById(id, { transaction: opts.transaction });
    this.assertRowWritable(row);
    const data = { ...values } as Partial<TenantAttrs>;
    delete data.instituteId;
    this.assertBranchAssignable(data.branchId);
    return row.update(data as Partial<Attributes<M>>, opts);
  }

  async destroy(id: number, opts: { transaction?: Transaction } = {}) {
    const row = await this.findById(id, { transaction: opts.transaction });
    this.assertRowWritable(row);
    await row.destroy(opts);
    return row;
  }
}
