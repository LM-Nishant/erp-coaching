import type {
  MktCategoryDto,
  MktLectureContentDto,
  MktLedgerEntryDto,
  MktPage,
  MktReviewItemDto,
  MktSettingsDto,
  MktStudioCourseDto,
} from '@erp/shared';
import { literal } from 'sequelize';
import { getContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { MktCategory, MktCourse, MktLecture, MktMedia, MktOrder, MktSaleLedger, MktSeller } from './models';
import { readiness, toStudioDto } from './courses.service';
import { notifyCourseDecision } from './decisions.notify';
import { listCategories } from './catalog.service';
import { lectureContent } from './learning.service';
import { sellerRef, toSellerAdminDto } from './sellers.service';
import { iso, platformSettings, slugify } from './util';

const withSeller = {
  include: [{ model: MktSeller, as: 'seller', include: [{ model: MktMedia, as: 'avatar' }] }],
};

export async function reviewQueue(status = 'in_review'): Promise<MktReviewItemDto[]> {
  const rows = await MktCourse.findAll({
    where: { status },
    ...withSeller,
    order: [
      ['submittedAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: 200,
  });
  return Promise.all(
    rows.map(async (c) => ({ course: await toStudioDto(c), seller: await toSellerAdminDto(c.seller!) })),
  );
}

async function course(id: number) {
  const c = await MktCourse.findByPk(id, withSeller);
  if (!c) throw NotFound('Course');
  return c;
}

export async function reviewCourse(id: number): Promise<MktReviewItemDto & { issues: string[] }> {
  const c = await course(id);
  return {
    course: await toStudioDto(c),
    seller: await toSellerAdminDto(c.seller!),
    issues: (await readiness(c)).issues,
  };
}

/** Any lecture of any course, for reviewers. */
export async function reviewLecture(courseId: number, lectureId: number): Promise<MktLectureContentDto> {
  const l = await MktLecture.findOne({
    where: { id: lectureId, courseId },
    include: [{ model: MktMedia, as: 'media' }],
  });
  if (!l) throw NotFound('Lecture');
  return lectureContent(l, getContext().userId!);
}

async function decide(id: number, action: string, apply: (c: MktCourse) => Promise<void>, note?: string) {
  const c = await course(id);
  await apply(c);
  await audit({
    action: `marketplace.course.${action}`,
    entityType: 'mkt_course',
    entityId: id,
    instituteId: null,
    metadata: note ? { note } : undefined,
  });
  return toStudioDto(c);
}

async function tellSeller(id: number, approved: boolean, note: string | null) {
  const c = await MktCourse.findByPk(id);
  const seller = c && (await MktSeller.findByPk(c.sellerId));
  if (c && seller) await notifyCourseDecision(seller, c, approved, note);
}

const reviewed = () => ({ reviewedAt: new Date(), reviewedByUserId: getContext().userId ?? null });

export async function approveCourse(id: number, note?: string | null): Promise<MktStudioCourseDto> {
  const dto = await decide(
    id,
    'approved',
    async (c) => {
      if (c.status !== 'in_review')
        throw Conflict('Only courses in review can be approved', 'INVALID_STATUS');
      await c.update({
        status: 'published',
        reviewNote: note || null,
        publishedAt: c.publishedAt ?? new Date(),
        ...reviewed(),
      });
    },
    note ?? undefined,
  );
  await tellSeller(id, true, note || null);
  return dto;
}

export async function rejectCourse(id: number, reason: string): Promise<MktStudioCourseDto> {
  if (!reason.trim()) throw BadRequest('Tell the instructor what to change');
  const dto = await decide(
    id,
    'rejected',
    async (c) => {
      if (c.status !== 'in_review')
        throw Conflict('Only courses in review can be sent back', 'INVALID_STATUS');
      await c.update({ status: 'rejected', reviewNote: reason.trim(), ...reviewed() });
    },
    reason,
  );
  await tellSeller(id, false, reason.trim());
  return dto;
}

/** Re-lists a course that was approved before and then unpublished. */
export function publishCourse(id: number): Promise<MktStudioCourseDto> {
  return decide(id, 'published', async (c) => {
    if (c.status !== 'unpublished' || !c.publishedAt)
      throw Conflict('Only previously approved courses can be re-published directly', 'INVALID_STATUS');
    await c.update({ status: 'published', ...reviewed() });
  });
}

export function unpublishCourse(id: number, reason?: string | null): Promise<MktStudioCourseDto> {
  return decide(
    id,
    'unpublished',
    async (c) => {
      if (c.status !== 'published')
        throw Conflict('Only published courses can be unpublished', 'INVALID_STATUS');
      await c.update({ status: 'unpublished', reviewNote: reason || null, ...reviewed() });
    },
    reason ?? undefined,
  );
}

// ---------------------------------------------------------------- categories

export async function saveCategory(
  id: number | null,
  input: { name: string; slug?: string; parentId?: number | null; icon?: string | null; sortOrder?: number },
): Promise<MktCategoryDto[]> {
  if (input.parentId) {
    const parent = await MktCategory.findByPk(input.parentId);
    if (!parent || parent.parentId) throw BadRequest('Subcategories go under a top-level category');
    if (id && input.parentId === id) throw BadRequest('A category cannot be its own parent');
  }
  const slug = slugify(input.slug || input.name);
  const clash = await MktCategory.findOne({ where: { slug } });
  if (clash && clash.id !== id) throw Conflict('A category with this link name exists', 'SLUG_TAKEN');
  const fields = {
    name: input.name,
    slug,
    parentId: input.parentId ?? null,
    icon: input.icon ?? null,
    ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
  };
  if (id) {
    const c = await MktCategory.findByPk(id);
    if (!c) throw NotFound('Category');
    if (fields.parentId && (await MktCategory.count({ where: { parentId: id } })))
      throw BadRequest('A category with subcategories cannot become a subcategory');
    await c.update(fields);
  } else await MktCategory.create(fields);
  await audit({
    action: 'marketplace.category.saved',
    entityType: 'mkt_category',
    entityId: id ?? slug,
    instituteId: null,
  });
  return listCategories();
}

export async function deleteCategory(id: number) {
  const c = await MktCategory.findByPk(id);
  if (!c) throw NotFound('Category');
  const used =
    (await MktCourse.count({ where: { categoryId: id } })) +
    (await MktCourse.count({ where: { subcategoryId: id } }));
  if (used) throw Conflict('Move its courses to another category first', 'CATEGORY_IN_USE');
  await c.destroy();
  await audit({
    action: 'marketplace.category.deleted',
    entityType: 'mkt_category',
    entityId: id,
    instituteId: null,
  });
  return listCategories();
}

// ---------------------------------------------------------------- settings & ledger

export async function getSettings(): Promise<MktSettingsDto> {
  const s = await platformSettings();
  return { commissionPercent: s.commissionPercent, instructorSignupOpen: s.instructorSignupOpen };
}

export async function updateSettings(input: Partial<MktSettingsDto>): Promise<MktSettingsDto> {
  const s = await platformSettings();
  await s.update(input);
  await audit({
    action: 'marketplace.settings.updated',
    entityType: 'mkt_settings',
    entityId: s.id,
    instituteId: null,
    metadata: input,
  });
  return getSettings();
}

export async function ledger(q: {
  sellerId?: number;
  page?: number;
  pageSize?: number;
}): Promise<
  MktPage<MktLedgerEntryDto> & { totals: { grossPaise: number; commissionPaise: number; netPaise: number } }
> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
  const where = q.sellerId ? { sellerId: q.sellerId } : {};
  const [{ rows, count }, totals] = await Promise.all([
    MktSaleLedger.findAndCountAll({
      where,
      include: [
        { model: MktSeller, as: 'seller', include: [{ model: MktMedia, as: 'avatar' }] },
        { model: MktCourse, as: 'course', attributes: ['id', 'title'] },
        { model: MktOrder, as: 'order', attributes: ['id', 'number'] },
      ],
      order: [['id', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    MktSaleLedger.findOne({
      where,
      // Refund rows reverse a sale, so they count negatively.
      attributes: (['gross', 'commission', 'net'] as const).map((c) => [
        literal(
          `COALESCE(SUM(CASE WHEN entry_type = 'refund' THEN -CAST(${c}_paise AS SIGNED) ELSE CAST(${c}_paise AS SIGNED) END), 0)`,
        ),
        c[0],
      ]),
      raw: true,
    }) as Promise<{ g: string; c: string; n: string } | null>,
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      entryType: r.entryType,
      orderId: r.orderId,
      orderNumber: r.order?.number ?? '',
      courseId: r.courseId,
      courseTitle: r.course?.title ?? '',
      seller: sellerRef(r.seller!),
      grossPaise: r.grossPaise,
      commissionPercent: r.commissionPercent,
      commissionPaise: r.commissionPaise,
      netPaise: r.netPaise,
      payoutId: r.payoutId,
      createdAt: iso(r.createdAt)!,
    })),
    total: count,
    page,
    pageSize,
    totals: {
      grossPaise: Number(totals?.g ?? 0),
      commissionPaise: Number(totals?.c ?? 0),
      netPaise: Number(totals?.n ?? 0),
    },
  };
}
