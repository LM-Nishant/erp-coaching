import { Op, QueryTypes, UniqueConstraintError, fn, col, literal, type WhereOptions } from 'sequelize';
import {
  GRIEVANCE_PRIORITIES,
  GRIEVANCE_STATUSES,
  GRIEVANCE_TRANSITIONS,
  type CreateGrievanceInput,
  type GrievanceActivityDto,
  type GrievanceAttachmentDto,
  type GrievanceCategoryDto,
  type GrievanceCategoryInput,
  type GrievancePriority,
  type GrievanceReportSummary,
  type GrievanceRequesterType,
  type GrievanceSettingsDto,
  type GrievanceStatus,
  type GrievanceTicketDetailDto,
  type GrievanceTicketDto,
  type GrievanceUserRef,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { enqueueJob } from '../../infrastructure/jobs/queue';
import { Job } from '../../infrastructure/jobs/job.model';
import { getContext, hasPermission, requireTenantContext, runWithContext } from '../../shared/context';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { paginated, toLimitOffset } from '../../shared/utilities/pagination';
import { UserRole } from '../permissions/models';
import { resolveAccess } from '../permissions/access.service';
import { FileObject } from '../files/file.model';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import { User } from '../users/user.model';
import {
  GrievanceActivity,
  GrievanceAttachment,
  GrievanceCategory,
  GrievanceSetting,
  GrievanceTicket,
  ticketIncludes,
  userInclude,
} from './grievances.models';
import { notifyGrievanceUsers } from './grievances.notifier';
import { getLinkedStudents } from './grievances.links';

export const MODULE = 'grievances';
export const SLA_SWEEP_JOB = 'grievances.sla-sweep';
export const SLA_CHECK_JOB = 'grievances.sla-check';
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const REQUESTER_REOPEN_WINDOW_DAYS = 30;
const MAX_ATTACHMENTS_PER_TICKET = 25;
const HOUR_MS = 3600 * 1000;

const DEFAULT_CATEGORIES: { name: string; slaHours: number }[] = [
  { name: 'Academics', slaHours: 72 },
  { name: 'Fees & payments', slaHours: 48 },
  { name: 'Facilities & infrastructure', slaHours: 96 },
  { name: 'Staff conduct', slaHours: 48 },
  { name: 'Transport', slaHours: 48 },
  { name: 'Other', slaHours: 72 },
];

export const settingsRepo = new TenantRepository(GrievanceSetting, { entity: 'Grievance settings' });
export const categoryRepo = new TenantRepository(GrievanceCategory, { entity: 'Grievance category' });
/** Staff queue access: limited to the handler's allowed branches. */
export const ticketRepo = new TenantRepository(GrievanceTicket, { entity: 'Grievance', branchScoped: true });
/** Requester access: institute-scoped, always combined with an ownership condition. */
const ownTicketRepo = new TenantRepository(GrievanceTicket, { entity: 'Grievance' });
const activityRepo = new TenantRepository(GrievanceActivity, { entity: 'Grievance activity' });
const attachmentRepo = new TenantRepository(GrievanceAttachment, { entity: 'Attachment' });

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const userRef = (u: User | null | undefined): GrievanceUserRef | null =>
  u ? { id: u.id, name: u.name } : null;

function currentUserId(): number {
  const { userId } = getContext();
  if (!userId) throw Forbidden('A signed-in user is required');
  return userId;
}

// ---------------------------------------------------------------- settings & categories

/** Creates the settings row and default categories the first time an institute uses the module. */
export async function getOrInitSettings(): Promise<GrievanceSetting> {
  const existing = await settingsRepo.findOne();
  if (existing) return existing;
  try {
    return await getSequelize().transaction(async (transaction) => {
      const s = await settingsRepo.create({ escalationUserId: null }, { transaction });
      for (const c of DEFAULT_CATEGORIES) {
        await categoryRepo.create(
          { name: c.name, slaHours: c.slaHours, description: null, defaultAssigneeUserId: null },
          { transaction },
        );
      }
      return s;
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const s = await settingsRepo.findOne();
      if (s) return s;
    }
    throw err;
  }
}

export const settingsDto = (s: GrievanceSetting): GrievanceSettingsDto => ({
  ticketPrefix: s.ticketPrefix,
  defaultSlaHours: s.defaultSlaHours,
  escalationUserId: s.escalationUserId,
});

export async function updateSettings(input: Partial<GrievanceSettingsDto>) {
  const s = await getOrInitSettings();
  if (input.escalationUserId) await assertCanHandle(input.escalationUserId);
  const before = settingsDto(s);
  await s.update(input);
  await audit({
    action: 'grievance.settings_updated',
    entityType: 'grievance_settings',
    entityId: s.id,
    metadata: { before, after: settingsDto(s) },
  });
  return settingsDto(s);
}

export const categoryDto = (c: GrievanceCategory): GrievanceCategoryDto => ({
  id: c.id,
  name: c.name,
  description: c.description,
  defaultAssigneeUserId: c.defaultAssigneeUserId,
  defaultAssigneeName: c.defaultAssignee?.name ?? null,
  slaHours: c.slaHours,
  isActive: c.isActive,
});

export async function listCategories(includeInactive: boolean) {
  await getOrInitSettings();
  const rows = await categoryRepo.findAll({
    where: includeInactive ? {} : { isActive: true },
    include: [userInclude('defaultAssignee')],
    order: [['name', 'ASC']],
  });
  return rows.map(categoryDto);
}

async function assertUniqueCategoryName(name: string, exceptId?: number) {
  const clash = await categoryRepo.findOne({
    where: { name, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
  });
  if (clash) throw Conflict('A category with this name already exists', 'DUPLICATE_CATEGORY');
}

export async function createCategory(input: GrievanceCategoryInput) {
  const settings = await getOrInitSettings();
  await assertUniqueCategoryName(input.name);
  if (input.defaultAssigneeUserId) await assertCanHandle(input.defaultAssigneeUserId);
  const c = await categoryRepo.create({
    name: input.name,
    description: input.description ?? null,
    defaultAssigneeUserId: input.defaultAssigneeUserId ?? null,
    slaHours: input.slaHours ?? settings.defaultSlaHours,
    isActive: input.isActive ?? true,
  });
  await audit({
    action: 'grievance.category_created',
    entityType: 'grievance_category',
    entityId: c.id,
    metadata: { after: categoryDto(c) },
  });
  return categoryDto(c);
}

export async function updateCategory(id: number, input: Partial<GrievanceCategoryInput>) {
  const c = await categoryRepo.findById(id);
  if (input.name) await assertUniqueCategoryName(input.name, id);
  if (input.defaultAssigneeUserId) await assertCanHandle(input.defaultAssigneeUserId);
  const before = categoryDto(c);
  await c.update(input);
  await audit({
    action: 'grievance.category_updated',
    entityType: 'grievance_category',
    entityId: id,
    metadata: { before, after: categoryDto(c) },
  });
  return categoryDto(c);
}

export async function deleteCategory(id: number) {
  const c = await categoryRepo.findById(id);
  if (await ownTicketRepo.count({ categoryId: id }))
    throw Conflict('Category has tickets; deactivate it instead', 'CATEGORY_IN_USE');
  const before = categoryDto(c);
  await c.destroy();
  await audit({
    action: 'grievance.category_deleted',
    entityType: 'grievance_category',
    entityId: id,
    metadata: { before },
  });
}

// ---------------------------------------------------------------- people

/** Users of the current institute who can work the grievance queue. */
export async function listAssignees(): Promise<GrievanceUserRef[]> {
  const { instituteId } = requireTenantContext();
  return getSequelize().query<GrievanceUserRef>(
    `SELECT DISTINCT u.id, u.name
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id AND u.status = 'active'
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.institute_id = :instituteId AND p.\`key\` = 'grievances.edit'
      ORDER BY u.name`,
    { replacements: { instituteId }, type: QueryTypes.SELECT },
  );
}

async function assertCanHandle(userId: number) {
  const { instituteId } = requireTenantContext();
  const member = await UserRole.count({ where: { userId, instituteId } });
  const access = member ? await resolveAccess(userId, instituteId) : null;
  if (!access?.permissions.has('grievances.edit'))
    throw BadRequest('The selected user cannot handle grievances', { userId });
}

function requesterTypeFromRoles(): GrievanceRequesterType {
  const roles = getContext().roles ?? [];
  if (roles.includes('parent')) return 'parent';
  if (roles.includes('student')) return 'student';
  return 'staff';
}

export async function linkedStudentsForCurrentUser() {
  const { instituteId } = requireTenantContext();
  if (!(getContext().roles ?? []).includes('parent')) return [];
  return getLinkedStudents(currentUserId(), instituteId);
}

// ---------------------------------------------------------------- tickets

export function ticketDto(t: GrievanceTicket): GrievanceTicketDto {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    branchId: t.branchId,
    categoryId: t.categoryId,
    categoryName: t.category?.name ?? null,
    subject: t.subject,
    description: t.description,
    priority: t.priority,
    status: t.status,
    requesterType: t.requesterType,
    requester: userRef(t.requester),
    onBehalfOf: userRef(t.onBehalfOf),
    assignee: userRef(t.assignee),
    dueAt: iso(t.dueAt),
    firstResponseAt: iso(t.firstResponseAt),
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    escalatedAt: iso(t.escalatedAt),
    escalationLevel: t.escalationLevel,
    slaBreached: !!t.slaBreached,
    reopenCount: t.reopenCount,
    resolutionNotes: t.resolutionNotes ?? null,
    closureConfirmed: t.closureConfirmed ?? null,
    satisfactionRating: t.satisfactionRating ?? null,
    closureFeedback: t.closureFeedback ?? null,
    createdAt: iso(t.createdAt)!,
    updatedAt: iso(t.updatedAt)!,
  };
}

/**
 * Concurrency-safe per-institute, per-year sequence. The upsert takes an exclusive row lock that
 * is held until the surrounding transaction commits, so parallel creates serialise on it.
 */
async function nextTicketNumber(prefix: string, transaction: import('sequelize').Transaction) {
  const { instituteId } = requireTenantContext();
  const year = new Date().getUTCFullYear();
  const sequelize = getSequelize();
  await sequelize.query(
    `INSERT INTO grievance_counters (institute_id, year, last_number, created_at, updated_at)
     VALUES (:instituteId, :year, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE last_number = last_number + 1, updated_at = NOW()`,
    { replacements: { instituteId, year }, transaction },
  );
  const [row] = await sequelize.query<{ n: number }>(
    'SELECT last_number AS n FROM grievance_counters WHERE institute_id = :instituteId AND year = :year',
    { replacements: { instituteId, year }, type: QueryTypes.SELECT, transaction },
  );
  return `${prefix}-${year}-${String(row.n).padStart(5, '0')}`;
}

async function loadFull(id: number) {
  const t = await ownTicketRepo.findOne({ where: { id }, include: ticketIncludes() });
  if (!t) throw NotFound('Grievance');
  return t;
}

async function scheduleSlaCheck(t: GrievanceTicket) {
  if (t.dueAt) await enqueueJob(SLA_CHECK_JOB, { ticketId: t.id }, { runAt: t.dueAt });
}

async function addActivity(
  t: GrievanceTicket,
  values: {
    type: GrievanceActivity['type'];
    body?: string | null;
    isInternal?: boolean;
    metadata?: Record<string, unknown> | null;
    system?: boolean;
  },
  transaction?: import('sequelize').Transaction,
) {
  return activityRepo.create(
    {
      ticketId: t.id,
      authorUserId: values.system ? null : (getContext().userId ?? null),
      type: values.type,
      body: values.body ?? null,
      isInternal: values.isInternal ?? false,
      metadata: values.metadata ?? null,
    },
    { transaction },
  );
}

export async function createTicket(input: CreateGrievanceInput) {
  const ctx = requireTenantContext();
  const userId = currentUserId();
  const settings = await getOrInitSettings();
  const category = await categoryRepo.findById(input.categoryId);
  if (!category.isActive) throw BadRequest('This category is no longer accepting complaints');

  const requesterType = requesterTypeFromRoles();
  let onBehalfOfUserId: number | null = null;
  if (input.onBehalfOfUserId && input.onBehalfOfUserId !== userId) {
    const linked = requesterType === 'parent' ? await getLinkedStudents(userId, ctx.instituteId) : [];
    if (!linked.some((s) => s.id === input.onBehalfOfUserId))
      throw Forbidden('You can only file complaints for your linked children', 'NOT_LINKED_STUDENT');
    onBehalfOfUserId = input.onBehalfOfUserId;
  }

  let branchId = input.branchId ?? ctx.activeBranchId ?? null;
  if (branchId == null && ctx.allowedBranchIds?.length === 1) branchId = ctx.allowedBranchIds[0];
  if (input.branchId != null) ticketRepo.assertBranchAllowed(input.branchId);

  const slaHours = category.slaHours || settings.defaultSlaHours;
  const ticket = await getSequelize().transaction(async (transaction) => {
    const ticketNumber = await nextTicketNumber(settings.ticketPrefix, transaction);
    const t = await ownTicketRepo.create(
      {
        branchId,
        ticketNumber,
        categoryId: category.id,
        subject: input.subject,
        description: input.description,
        priority: input.priority ?? 'medium',
        requesterType,
        requesterUserId: userId,
        onBehalfOfUserId,
        assigneeUserId: category.defaultAssigneeUserId,
        dueAt: new Date(Date.now() + slaHours * HOUR_MS),
      },
      { transaction },
    );
    await addActivity(t, { type: 'system', body: 'Complaint submitted' }, transaction);
    return t;
  });

  await scheduleSlaCheck(ticket);
  await audit({
    action: 'grievance.created',
    entityType: 'grievance',
    entityId: ticket.id,
    metadata: {
      after: { ticketNumber: ticket.ticketNumber, categoryId: category.id, priority: ticket.priority },
    },
  });
  await notifyGrievanceUsers([ticket.assigneeUserId], {
    ticketId: ticket.id,
    title: `New complaint ${ticket.ticketNumber}`,
    body: ticket.subject,
  });
  return ticketDto(await loadFull(ticket.id));
}

/**
 * Loads a ticket for the caller. Handlers (`grievances.edit`) see tickets in their branches;
 * everyone else only sees tickets they filed. Foreign tickets are always 404.
 */
async function accessTicket(id: number, opts: { manage?: boolean } = {}) {
  if (hasPermission('grievances.edit')) {
    const t = await ticketRepo.findOne({ where: { id } });
    if (t) return { ticket: t, canManage: true };
  }
  if (opts.manage) throw NotFound('Grievance');
  const t = await ownTicketRepo.findOne({ where: { id, requesterUserId: currentUserId() } });
  if (!t) throw NotFound('Grievance');
  return { ticket: t, canManage: false };
}

export interface TicketListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: GrievanceStatus[];
  priority?: GrievancePriority;
  categoryId?: number;
  assignee?: 'me' | 'unassigned' | number;
  overdue?: boolean;
  from?: Date;
  to?: Date;
}

function listWhere(q: TicketListQuery): WhereOptions<GrievanceTicket> {
  const where: Record<string | symbol, unknown> = {};
  if (q.status?.length) where.status = { [Op.in]: q.status };
  if (q.priority) where.priority = q.priority;
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.assignee === 'me') where.assigneeUserId = currentUserId();
  else if (q.assignee === 'unassigned') where.assigneeUserId = null;
  else if (typeof q.assignee === 'number') where.assigneeUserId = q.assignee;
  if (q.overdue) {
    where.dueAt = { [Op.lt]: new Date() };
    if (!q.status?.length) where.status = { [Op.in]: ['open', 'in_progress', 'escalated'] };
  }
  if (q.from || q.to)
    where.createdAt = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
  if (q.search) {
    const like = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
    where[Op.or] = [{ ticketNumber: { [Op.like]: like } }, { subject: { [Op.like]: like } }];
  }
  return where as WhereOptions<GrievanceTicket>;
}

export async function listTickets(q: TicketListQuery, mode: 'queue' | 'mine') {
  const where = listWhere(q);
  const repo = mode === 'queue' ? ticketRepo : ownTicketRepo;
  const scoped =
    mode === 'queue'
      ? where
      : ({ ...where, requesterUserId: currentUserId() } as WhereOptions<GrievanceTicket>);
  const { rows, count } = await repo.findAndCountAll({
    where: scoped,
    include: ticketIncludes(),
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    ...toLimitOffset(q),
  });
  return paginated(rows.map(ticketDto), count, q);
}

const activityDto = (a: GrievanceActivity): GrievanceActivityDto => ({
  id: a.id,
  type: a.type,
  isInternal: !!a.isInternal,
  body: a.body,
  author: userRef(a.author),
  metadata: a.metadata,
  createdAt: iso(a.createdAt)!,
});

const attachmentDto = (a: GrievanceAttachment): GrievanceAttachmentDto => ({
  id: a.id,
  fileId: a.fileId,
  commentId: a.activityId,
  originalName: a.file?.originalName ?? 'file',
  mimeType: a.file?.mimeType ?? 'application/octet-stream',
  sizeBytes: Number(a.file?.sizeBytes ?? 0),
  isInternal: !!a.isInternal,
  createdAt: iso(a.createdAt)!,
});

export async function getTicketDetail(id: number): Promise<GrievanceTicketDetailDto> {
  const { canManage } = await accessTicket(id);
  const t = await loadFull(id);
  const visibility = canManage ? {} : { isInternal: false };
  const [activities, attachments] = await Promise.all([
    activityRepo.findAll({
      where: { ticketId: id, ...visibility },
      include: [userInclude('author')],
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    attachmentRepo.findAll({
      where: { ticketId: id, ...visibility },
      include: [
        { model: FileObject, as: 'file', attributes: ['id', 'originalName', 'mimeType', 'sizeBytes'] },
      ],
      order: [['id', 'ASC']],
    }),
  ]);
  return {
    ...ticketDto(t),
    activities: activities.map(activityDto),
    attachments: attachments.map(attachmentDto),
    canManage,
  };
}

export async function updateTicket(id: number, input: { priority?: GrievancePriority; categoryId?: number }) {
  const { ticket: t } = await accessTicket(id, { manage: true });
  const before = { priority: t.priority, categoryId: t.categoryId, dueAt: iso(t.dueAt) };
  const changes: Partial<GrievanceTicket> = {};
  if (input.priority) changes.priority = input.priority;
  if (input.categoryId && input.categoryId !== t.categoryId) {
    const category = await categoryRepo.findById(input.categoryId);
    changes.categoryId = category.id;
    if (!t.resolvedAt) {
      const settings = await getOrInitSettings();
      changes.dueAt = new Date(
        t.createdAt.getTime() + (category.slaHours || settings.defaultSlaHours) * HOUR_MS,
      );
    }
  }
  await t.update(changes);
  if (changes.dueAt) await scheduleSlaCheck(t);
  await addActivity(t, {
    type: 'system',
    isInternal: true,
    body: 'Ticket details updated',
    metadata: { before, changes },
  });
  await audit({
    action: 'grievance.updated',
    entityType: 'grievance',
    entityId: id,
    metadata: { before, after: { priority: t.priority, categoryId: t.categoryId, dueAt: iso(t.dueAt) } },
  });
  return ticketDto(await loadFull(id));
}

export async function assignTicket(id: number, input: { assigneeUserId: number | null; note?: string }) {
  const { ticket: t } = await accessTicket(id, { manage: true });
  if (input.assigneeUserId) await assertCanHandle(input.assigneeUserId);
  const from = t.assigneeUserId;
  await t.update({ assigneeUserId: input.assigneeUserId });
  await addActivity(t, {
    type: 'assignment',
    isInternal: true,
    body: input.note ?? null,
    metadata: { from, to: input.assigneeUserId },
  });
  await audit({
    action: from ? 'grievance.reassigned' : 'grievance.assigned',
    entityType: 'grievance',
    entityId: id,
    metadata: { before: { assigneeUserId: from }, after: { assigneeUserId: input.assigneeUserId } },
  });
  await notifyGrievanceUsers([input.assigneeUserId], {
    ticketId: t.id,
    title: `Complaint ${t.ticketNumber} assigned to you`,
    body: t.subject,
  });
  return ticketDto(await loadFull(id));
}

async function slaHoursFor(t: GrievanceTicket) {
  const [category, settings] = await Promise.all([
    categoryRepo.findOne({ where: { id: t.categoryId } }),
    getOrInitSettings(),
  ]);
  return category?.slaHours || settings.defaultSlaHours;
}

async function reopenChanges(t: GrievanceTicket) {
  return {
    status: 'open' as const,
    resolvedAt: null,
    closedAt: null,
    closureConfirmed: null,
    reopenCount: t.reopenCount + 1,
    dueAt: new Date(Date.now() + (await slaHoursFor(t)) * HOUR_MS),
  };
}

export async function changeStatus(
  id: number,
  input: { status: GrievanceStatus; note?: string; resolutionNotes?: string },
) {
  const { ticket: t } = await accessTicket(id, { manage: true });
  const from = t.status as GrievanceStatus;
  if (!GRIEVANCE_TRANSITIONS[from].includes(input.status))
    throw Conflict(`Cannot move a ${from} ticket to ${input.status}`, 'INVALID_TRANSITION');

  const now = new Date();
  const changes: Partial<GrievanceTicket> = { status: input.status };
  const userId = currentUserId();
  if (!t.firstResponseAt && userId !== t.requesterUserId) changes.firstResponseAt = now;
  switch (input.status) {
    case 'escalated':
      Object.assign(changes, { escalatedAt: now, escalationLevel: t.escalationLevel + 1 });
      break;
    case 'resolved':
      if (!input.resolutionNotes) throw BadRequest('Resolution notes are required to resolve a ticket');
      Object.assign(changes, {
        resolvedAt: now,
        resolutionNotes: input.resolutionNotes,
        slaBreached: t.slaBreached || (!!t.dueAt && now > t.dueAt),
      });
      break;
    case 'closed':
      Object.assign(changes, {
        closedAt: now,
        resolvedAt: t.resolvedAt ?? now,
        resolutionNotes: input.resolutionNotes ?? t.resolutionNotes,
        slaBreached: t.slaBreached || (!t.resolvedAt && !!t.dueAt && now > t.dueAt),
      });
      break;
    case 'open':
      Object.assign(changes, await reopenChanges(t));
      break;
  }
  await t.update(changes);
  if (input.status === 'open') await scheduleSlaCheck(t);
  await addActivity(t, {
    type: 'status_change',
    body: input.status === 'resolved' ? input.resolutionNotes : (input.note ?? null),
    metadata: { from, to: input.status },
  });
  await audit({
    action: `grievance.${input.status === 'open' ? 'reopened' : input.status}`,
    entityType: 'grievance',
    entityId: id,
    metadata: { before: { status: from }, after: { status: input.status } },
  });
  await notifyGrievanceUsers([t.requesterUserId], {
    ticketId: t.id,
    title: `Complaint ${t.ticketNumber} is now ${input.status.replace('_', ' ')}`,
    body: input.status === 'resolved' ? `${input.resolutionNotes}` : t.subject,
  });
  return ticketDto(await loadFull(id));
}

export async function addComment(id: number, input: { body: string; internal?: boolean }) {
  const { ticket: t, canManage } = await accessTicket(id);
  if (input.internal && !canManage) throw Forbidden('Only staff can add internal notes');
  if (t.status === 'closed')
    throw Conflict('This ticket is closed; reopen it to add a reply', 'TICKET_CLOSED');
  const userId = currentUserId();
  const a = await addActivity(t, {
    type: input.internal ? 'internal_note' : 'reply',
    body: input.body,
    isInternal: !!input.internal,
  });
  if (canManage && !input.internal && !t.firstResponseAt && userId !== t.requesterUserId) {
    await t.update({ firstResponseAt: new Date() });
  }
  await audit({
    action: input.internal ? 'grievance.internal_note_added' : 'grievance.replied',
    entityType: 'grievance',
    entityId: id,
    metadata: { activityId: a.id },
  });
  const recipients = input.internal
    ? [t.assigneeUserId]
    : userId === t.requesterUserId
      ? [t.assigneeUserId]
      : [t.requesterUserId, t.assigneeUserId];
  await notifyGrievanceUsers(recipients, {
    ticketId: t.id,
    title: `New ${input.internal ? 'internal note' : 'reply'} on ${t.ticketNumber}`,
    body: input.body.slice(0, 200),
  });
  const full = await activityRepo.findOne({ where: { id: a.id }, include: [userInclude('author')] });
  return activityDto(full!);
}

export async function reopenTicket(id: number, input: { reason: string }) {
  const { ticket: t, canManage } = await accessTicket(id);
  if (!['resolved', 'closed'].includes(t.status))
    throw Conflict('Only resolved or closed tickets can be reopened', 'INVALID_TRANSITION');
  const since = t.closedAt ?? t.resolvedAt;
  if (!canManage && since && Date.now() - since.getTime() > REQUESTER_REOPEN_WINDOW_DAYS * 24 * HOUR_MS)
    throw Conflict(
      `Tickets can be reopened within ${REQUESTER_REOPEN_WINDOW_DAYS} days; please file a new complaint`,
      'REOPEN_WINDOW_EXPIRED',
    );
  const from = t.status as GrievanceStatus;
  await t.update(await reopenChanges(t));
  await scheduleSlaCheck(t);
  await addActivity(t, {
    type: 'status_change',
    body: input.reason,
    metadata: { from, to: 'open', reopened: true },
  });
  await audit({
    action: 'grievance.reopened',
    entityType: 'grievance',
    entityId: id,
    metadata: { before: { status: from }, after: { status: 'open' }, reason: input.reason },
  });
  await notifyGrievanceUsers([t.assigneeUserId, t.requesterUserId], {
    ticketId: t.id,
    title: `Complaint ${t.ticketNumber} was reopened`,
    body: input.reason.slice(0, 200),
  });
  return ticketDto(await loadFull(id));
}

export async function confirmClosure(id: number, input: { rating?: number; feedback?: string }) {
  const { ticket: t } = await accessTicket(id);
  if (t.requesterUserId !== currentUserId())
    throw Forbidden('Only the person who filed the complaint can confirm closure');
  if (t.status !== 'resolved')
    throw Conflict('Only resolved tickets can be confirmed and closed', 'INVALID_TRANSITION');
  await t.update({
    status: 'closed',
    closedAt: new Date(),
    closureConfirmed: true,
    satisfactionRating: input.rating ?? null,
    closureFeedback: input.feedback ?? null,
  });
  await addActivity(t, {
    type: 'status_change',
    body: input.feedback ?? 'Resolution confirmed by requester',
    metadata: { from: 'resolved', to: 'closed', confirmed: true, rating: input.rating ?? null },
  });
  await audit({
    action: 'grievance.closure_confirmed',
    entityType: 'grievance',
    entityId: id,
    metadata: { before: { status: 'resolved' }, after: { status: 'closed' }, rating: input.rating ?? null },
  });
  await notifyGrievanceUsers([t.assigneeUserId], {
    ticketId: t.id,
    title: `Complaint ${t.ticketNumber} closed by requester`,
    body: input.rating ? `Rating: ${input.rating}/5` : 'Resolution confirmed',
  });
  return ticketDto(await loadFull(id));
}

// ---------------------------------------------------------------- attachments

export async function addAttachment(
  id: number,
  file: { path: string; originalname: string; mimetype: string; size: number },
  input: { internal?: boolean; commentId?: number },
) {
  const { ticket: t, canManage } = await accessTicket(id);
  const discard = () => import('node:fs').then((fs) => fs.promises.rm(file.path, { force: true }));
  try {
    if (input.internal && !canManage) throw Forbidden('Only staff can add internal attachments');
    if (t.status === 'closed')
      throw Conflict('This ticket is closed; reopen it to add files', 'TICKET_CLOSED');
    if ((await attachmentRepo.count({ ticketId: id })) >= MAX_ATTACHMENTS_PER_TICKET)
      throw Conflict(
        `A ticket can have at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`,
        'TOO_MANY_ATTACHMENTS',
      );
    if (input.commentId) {
      const a = await activityRepo.findOne({ where: { id: input.commentId, ticketId: id } });
      if (!a || (a.isInternal && !canManage)) throw NotFound('Comment');
      if (a.authorUserId !== currentUserId())
        throw Forbidden('You can only attach files to your own comments');
    }
  } catch (err) {
    await discard();
    throw err;
  }
  const saved = await saveUploadedFile({
    tempPath: file.path,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    module: MODULE,
    branchId: t.branchId,
  });
  const att = await attachmentRepo.create({
    ticketId: id,
    activityId: input.commentId ?? null,
    fileId: saved.id,
    uploadedByUserId: currentUserId(),
    isInternal: !!input.internal,
  });
  att.file = saved;
  await audit({
    action: 'grievance.attachment_added',
    entityType: 'grievance',
    entityId: id,
    metadata: { attachmentId: att.id, fileId: saved.id, name: saved.originalName },
  });
  return attachmentDto(att);
}

export async function attachmentUrl(id: number, attachmentId: number) {
  const { canManage } = await accessTicket(id);
  const att = await attachmentRepo.findOne({ where: { id: attachmentId, ticketId: id } });
  if (!att || (att.isInternal && !canManage)) throw NotFound('Attachment');
  const { instituteId } = requireTenantContext();
  const file = await FileObject.findOne({ where: { id: att.fileId, instituteId } });
  if (!file) throw NotFound('Attachment');
  return signedUrlFor(file);
}

// ---------------------------------------------------------------- SLA escalation

/** Escalates an open/in-progress ticket whose SLA due time has passed. Runs in tenant context. */
export async function escalateIfOverdue(t: GrievanceTicket, now = new Date()): Promise<boolean> {
  if (!['open', 'in_progress'].includes(t.status) || !t.dueAt || t.dueAt > now) return false;
  const settings = await getOrInitSettings();
  const previousAssignee = t.assigneeUserId;
  await t.update({
    status: 'escalated',
    escalatedAt: now,
    escalationLevel: t.escalationLevel + 1,
    slaBreached: true,
    assigneeUserId: settings.escalationUserId ?? t.assigneeUserId,
  });
  await addActivity(t, {
    type: 'escalation',
    system: true,
    body: 'Response time limit (SLA) exceeded; ticket escalated automatically',
    metadata: { from: previousAssignee, to: t.assigneeUserId, dueAt: iso(t.dueAt) },
  });
  await audit({
    action: 'grievance.escalated',
    entityType: 'grievance',
    entityId: t.id,
    metadata: { automatic: true, dueAt: iso(t.dueAt), assigneeUserId: t.assigneeUserId },
  });
  await notifyGrievanceUsers([t.assigneeUserId, previousAssignee], {
    ticketId: t.id,
    title: `SLA breached: ${t.ticketNumber} escalated`,
    body: t.subject,
  });
  return true;
}

export async function runSlaCheck(payload: { ticketId?: number }) {
  if (!payload.ticketId) return;
  const t = await ownTicketRepo.findOne({ where: { id: payload.ticketId } });
  if (t) await escalateIfOverdue(t);
}

/** Safety net across all institutes; re-enqueues itself. */
export async function runSlaSweep() {
  try {
    // System job: scans every institute; each ticket is then handled in its own tenant context.
    const overdue = await GrievanceTicket.findAll({
      where: { status: { [Op.in]: ['open', 'in_progress'] }, dueAt: { [Op.lte]: new Date() } },
      attributes: ['id', 'instituteId'],
      limit: 500,
      tenantBypass: true,
    } as object);
    for (const row of overdue) {
      await runWithContext(
        { system: true, instituteId: row.instituteId, allowedBranchIds: null },
        async () => {
          const t = await ownTicketRepo.findOne({ where: { id: row.id } });
          if (t) await escalateIfOverdue(t);
        },
      );
    }
  } finally {
    await scheduleSlaSweep();
  }
}

export async function scheduleSlaSweep() {
  const pending = await Job.findOne({
    where: { name: SLA_SWEEP_JOB, status: { [Op.in]: ['pending', 'running'] } },
  });
  if (pending && pending.status === 'pending') return;
  await enqueueJob(SLA_SWEEP_JOB, {}, { instituteId: null, runAt: new Date(Date.now() + SWEEP_INTERVAL_MS) });
}

// ---------------------------------------------------------------- reports

export interface ReportQuery {
  from?: Date;
  to?: Date;
  categoryId?: number;
  branchId?: number;
}

function reportWhere(q: ReportQuery): WhereOptions<GrievanceTicket> {
  const where: Record<string, unknown> = {};
  if (q.from || q.to)
    where.createdAt = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.branchId) {
    ticketRepo.assertBranchAllowed(q.branchId);
    where.branchId = q.branchId;
  }
  return ticketRepo.scope(where as WhereOptions<GrievanceTicket>);
}

const hours = (v: unknown) => (v == null ? null : Math.round((Number(v) / 3600) * 100) / 100);
const FIRST_RESPONSE_SECS =
  'TIMESTAMPDIFF(SECOND, `GrievanceTicket`.`created_at`, `GrievanceTicket`.`first_response_at`)';
const RESOLUTION_SECS =
  'TIMESTAMPDIFF(SECOND, `GrievanceTicket`.`created_at`, `GrievanceTicket`.`resolved_at`)';

export async function reportSummary(q: ReportQuery): Promise<GrievanceReportSummary> {
  const where = reportWhere(q);
  const [byStatusRows, byPriorityRows, byCategoryRows, [totals]] = await Promise.all([
    GrievanceTicket.findAll({
      where,
      attributes: ['status', [fn('COUNT', col('GrievanceTicket.id')), 'n']],
      group: ['status'],
      raw: true,
    }),
    GrievanceTicket.findAll({
      where,
      attributes: ['priority', [fn('COUNT', col('GrievanceTicket.id')), 'n']],
      group: ['priority'],
      raw: true,
    }),
    GrievanceTicket.findAll({
      where,
      attributes: [
        'categoryId',
        [fn('COUNT', col('GrievanceTicket.id')), 'n'],
        [fn('AVG', literal(RESOLUTION_SECS)), 'resolutionSecs'],
      ],
      group: ['categoryId'],
      raw: true,
    }),
    GrievanceTicket.findAll({
      where,
      attributes: [
        [fn('COUNT', col('GrievanceTicket.id')), 'total'],
        [fn('AVG', literal(FIRST_RESPONSE_SECS)), 'firstResponseSecs'],
        [fn('AVG', literal(RESOLUTION_SECS)), 'resolutionSecs'],
        [fn('SUM', literal('`sla_breached` = 1')), 'breached'],
        [fn('SUM', literal('`resolved_at` IS NOT NULL')), 'resolved'],
        [fn('SUM', literal('`resolved_at` IS NOT NULL AND `sla_breached` = 0')), 'resolvedInSla'],
        [fn('SUM', literal('`reopen_count` > 0')), 'reopened'],
        [fn('AVG', col('satisfaction_rating')), 'avgRating'],
      ],
      raw: true,
    }),
  ]);
  type Row = Record<string, unknown>;
  const categories = await categoryRepo.findAll({ attributes: ['id', 'name'] });
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const byStatus = Object.fromEntries(
    GRIEVANCE_STATUSES.map((s) => [s, 0]),
  ) as GrievanceReportSummary['byStatus'];
  for (const r of byStatusRows as unknown as Row[]) byStatus[r.status as GrievanceStatus] = Number(r.n);
  const byPriority = Object.fromEntries(
    GRIEVANCE_PRIORITIES.map((p) => [p, 0]),
  ) as GrievanceReportSummary['byPriority'];
  for (const r of byPriorityRows as unknown as Row[])
    byPriority[r.priority as GrievancePriority] = Number(r.n);
  const t = totals as unknown as Row;
  const resolved = Number(t.resolved ?? 0);
  return {
    from: iso(q.from),
    to: iso(q.to),
    total: Number(t.total ?? 0),
    byStatus,
    byPriority,
    byCategory: (byCategoryRows as unknown as Row[]).map((r) => ({
      categoryId: Number(r.categoryId),
      name: names.get(Number(r.categoryId)) ?? `#${r.categoryId}`,
      total: Number(r.n),
      avgResolutionHours: hours(r.resolutionSecs),
    })),
    avgFirstResponseHours: hours(t.firstResponseSecs),
    avgResolutionHours: hours(t.resolutionSecs),
    slaBreached: Number(t.breached ?? 0),
    slaComplianceRate: resolved ? Math.round((Number(t.resolvedInSla ?? 0) / resolved) * 1000) / 10 : null,
    reopened: Number(t.reopened ?? 0),
    avgSatisfaction: t.avgRating == null ? null : Math.round(Number(t.avgRating) * 100) / 100,
  };
}

/** Quotes a CSV cell and neutralises spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const diffHours = (from: Date, to: Date | null) =>
  to ? Math.round(((to.getTime() - from.getTime()) / HOUR_MS) * 100) / 100 : null;

export async function exportCsv(q: ReportQuery): Promise<string> {
  const rows = await GrievanceTicket.findAll({
    where: reportWhere(q),
    include: ticketIncludes(),
    order: [['createdAt', 'ASC']],
    limit: 10000,
  });
  const header = [
    'Ticket',
    'Created at',
    'Category',
    'Priority',
    'Status',
    'Requester',
    'Requester type',
    'On behalf of',
    'Assignee',
    'Due at',
    'First response at',
    'Resolved at',
    'Closed at',
    'First response (h)',
    'Resolution (h)',
    'SLA breached',
    'Escalations',
    'Reopens',
    'Rating',
  ];
  const lines = rows.map((t) =>
    [
      t.ticketNumber,
      t.createdAt,
      t.category?.name,
      t.priority,
      t.status,
      t.requester?.name,
      t.requesterType,
      t.onBehalfOf?.name,
      t.assignee?.name,
      t.dueAt,
      t.firstResponseAt,
      t.resolvedAt,
      t.closedAt,
      diffHours(t.createdAt, t.firstResponseAt ?? null),
      diffHours(t.createdAt, t.resolvedAt ?? null),
      t.slaBreached ? 'yes' : 'no',
      t.escalationLevel,
      t.reopenCount,
      t.satisfactionRating,
    ]
      .map(csvCell)
      .join(','),
  );
  await audit({
    action: 'grievance.report_exported',
    entityType: 'grievance',
    metadata: { rows: rows.length, ...q },
  });
  return [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}
