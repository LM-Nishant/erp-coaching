/**
 * Resolves the live data a page's blocks need (course catalogue and batches from academics,
 * announcements, enquiry form fields from admissions). Runs inside a tenant context.
 */
import { Op, type WhereOptions } from 'sequelize';
import type { FormFieldDef, WebsiteBlock } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { Batch, BatchStudent, Course } from '../academics/api';
import { Branch } from '../branches/branch.model';
import { activeForm } from '../admissions/api';
import { resolveCoursePrices } from './hooks';
import { WebsiteAnnouncement } from './models';

export interface PublicCourse {
  id: number;
  name: string;
  code: string;
  description: string | null;
  mode: string;
  duration: string | null;
  price: string | null;
}
export interface PublicBatch {
  id: number;
  name: string;
  courseId: number;
  courseName: string | null;
  branchName: string | null;
  startDate: string;
  endDate: string | null;
  mode: string;
  seatsLeft: number;
}
export interface PublicAnnouncement {
  id: number;
  title: string;
  body: string | null;
  linkUrl: string | null;
  isPinned: boolean;
  date: string;
}

export interface BlockData {
  courses?: PublicCourse[];
  batches?: PublicBatch[];
  announcements?: PublicAnnouncement[];
  fields?: FormFieldDef[];
  branches?: { id: number; name: string }[];
  courseName?: string | null;
}

export type ResolvedBlock = WebsiteBlock & { data?: BlockData };

async function listCourses(ids?: number[] | null): Promise<PublicCourse[]> {
  const { instituteId } = requireTenantContext();
  if (!(await isModuleEnabled(instituteId, 'academics'))) return [];
  const where: Record<string, unknown> = { instituteId, status: 'active', isTemplate: false };
  if (ids?.length) where.id = { [Op.in]: ids };
  const rows = await Course.findAll({
    where: where as WhereOptions<Course>,
    order: [['name', 'ASC']],
    limit: 200,
  });
  const ordered = ids?.length
    ? ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is Course => !!r)
    : rows;
  const prices = await resolveCoursePrices(ordered.map((c) => c.id));
  return ordered.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    description: c.description,
    mode: c.mode,
    duration: c.durationValue && c.durationUnit ? `${c.durationValue} ${c.durationUnit}` : null,
    price: prices.get(c.id) ?? null,
  }));
}

async function listBatches(s: {
  courseId?: number | null;
  branchId?: number | null;
  upcomingOnly?: boolean;
  limit?: number;
}) {
  const { instituteId } = requireTenantContext();
  if (!(await isModuleEnabled(instituteId, 'academics'))) return [];
  const where: Record<string | symbol, unknown> = { instituteId, status: { [Op.in]: ['planned', 'active'] } };
  if (s.courseId) where.courseId = s.courseId;
  if (s.branchId) where.branchId = s.branchId;
  if (s.upcomingOnly !== false) {
    const today = new Date().toISOString().slice(0, 10);
    where[Op.or] = [{ endDate: null }, { endDate: { [Op.gte]: today } }];
  }
  const batches = await Batch.findAll({
    where: where as WhereOptions<Batch>,
    order: [['startDate', 'ASC']],
    limit: s.limit ?? 12,
  });
  if (!batches.length) return [];
  const ids = batches.map((b) => b.id);
  const [courses, branches, counts] = await Promise.all([
    Course.findAll({
      where: { instituteId, id: { [Op.in]: batches.map((b) => b.courseId) } },
      attributes: ['id', 'name'],
    }),
    Branch.findAll({
      where: { instituteId, id: { [Op.in]: batches.map((b) => b.branchId) } },
      attributes: ['id', 'name'],
    }),
    BatchStudent.count({
      where: { instituteId, batchId: { [Op.in]: ids }, status: 'active' },
      group: ['batchId'],
    }),
  ]);
  const enrolled = new Map(
    (counts as unknown as { batchId: number; count: number }[]).map((c) => [c.batchId, Number(c.count)]),
  );
  return batches.map<PublicBatch>((b) => ({
    id: b.id,
    name: b.name,
    courseId: b.courseId,
    courseName: courses.find((c) => c.id === b.courseId)?.name ?? null,
    branchName: branches.find((br) => br.id === b.branchId)?.name ?? null,
    startDate: b.startDate,
    endDate: b.endDate,
    mode: b.mode,
    seatsLeft: Math.max(0, b.capacity - (enrolled.get(b.id) ?? 0)),
  }));
}

export async function listPublicAnnouncements(limit = 10): Promise<PublicAnnouncement[]> {
  const { instituteId } = requireTenantContext();
  const now = new Date();
  const rows = await WebsiteAnnouncement.findAll({
    where: {
      instituteId,
      isPublished: true,
      [Op.and]: [
        { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
        { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gte]: now } }] },
      ],
    },
    order: [
      ['isPinned', 'DESC'],
      ['startsAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
  });
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    linkUrl: a.linkUrl,
    isPinned: a.isPinned,
    date: (a.startsAt ?? a.createdAt).toISOString(),
  }));
}

async function activeBranches() {
  const { instituteId } = requireTenantContext();
  const rows = await Branch.findAll({
    where: { instituteId, status: 'active' },
    attributes: ['id', 'name'],
    order: [['name', 'ASC']],
  });
  return rows.map((b) => ({ id: b.id, name: b.name }));
}

export async function resolveBlocks(blocks: WebsiteBlock[]): Promise<ResolvedBlock[]> {
  const out: ResolvedBlock[] = [];
  let branches: { id: number; name: string }[] | null = null;
  const getBranches = async () => (branches ??= await activeBranches());
  for (const b of blocks) {
    if (b.hidden) continue;
    switch (b.type) {
      case 'courses':
        out.push({ ...b, data: { courses: await listCourses(b.settings.courseIds) } });
        break;
      case 'batches':
        out.push({ ...b, data: { batches: await listBatches(b.settings) } });
        break;
      case 'announcements':
        out.push({ ...b, data: { announcements: await listPublicAnnouncements(b.settings.limit ?? 5) } });
        break;
      case 'enquiry_form': {
        const form = await activeForm('enquiry', b.settings.branchId ?? null);
        out.push({
          ...b,
          data: { fields: form?.fields ?? [], branches: b.settings.branchId ? [] : await getBranches() },
        });
        break;
      }
      case 'demo_form': {
        const course = b.settings.courseId ? (await listCourses([b.settings.courseId]))[0] : null;
        out.push({
          ...b,
          data: {
            courseName: course?.name ?? null,
            branches: b.settings.branchId ? [] : await getBranches(),
          },
        });
        break;
      }
      default:
        out.push(b);
    }
  }
  return out;
}

/** Courses visible on the catalogue (used to validate checkout requests). */
export async function findPublicCourse(courseId: number) {
  return (await listCourses([courseId]))[0] ?? null;
}
