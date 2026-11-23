import { Op, type WhereOptions } from 'sequelize';
import type {
  MktCatalogQuery,
  MktCategoryDto,
  MktCourseCardDto,
  MktCourseDetailDto,
  MktHomeDto,
  MktPage,
  MktSellerPublicDto,
  MktStreamDto,
} from '@erp/shared';
import { NotFound } from '../../shared/errors';
import { MktCategory, MktCourse, MktLecture, MktMedia, MktSeller } from './models';
import { streamFor } from './media.service';
import { cardInclude, curriculum, toCard } from './courses.service';
import { sellerRef } from './sellers.service';

/** Courses anyone can see: published by a seller that is not suspended. */
export const LIVE = { status: 'published' } as const;
const liveSeller = {
  model: MktSeller,
  as: 'seller',
  where: { status: 'active' },
  include: [{ model: MktMedia, as: 'avatar' }],
};
const liveInclude = [liveSeller, { model: MktMedia, as: 'thumbnail' }];

const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

export async function listCategories(): Promise<MktCategoryDto[]> {
  const [rows, counts] = await Promise.all([
    MktCategory.findAll({
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
    MktCourse.findAll({
      where: LIVE,
      attributes: ['categoryId', 'subcategoryId'],
      include: [{ ...liveSeller, attributes: [], include: [] }],
      raw: true,
    }),
  ]);
  const count = (id: number) => counts.filter((c) => c.categoryId === id || c.subcategoryId === id).length;
  const dto = (c: MktCategory): MktCategoryDto => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    parentId: c.parentId,
    icon: c.icon,
    sortOrder: c.sortOrder,
    courseCount: count(c.id),
    children: [],
  });
  const top = rows.filter((c) => !c.parentId).map(dto);
  for (const c of rows.filter((r) => r.parentId)) top.find((t) => t.id === c.parentId)?.children.push(dto(c));
  return top;
}

const ORDER: Record<string, [string, 'ASC' | 'DESC'][]> = {
  relevance: [
    ['enrolmentCount', 'DESC'],
    ['ratingAvg', 'DESC'],
    ['publishedAt', 'DESC'],
  ],
  popular: [
    ['enrolmentCount', 'DESC'],
    ['publishedAt', 'DESC'],
  ],
  rating: [
    ['ratingAvg', 'DESC'],
    ['ratingCount', 'DESC'],
  ],
  newest: [['publishedAt', 'DESC']],
  price_asc: [
    ['pricePaise', 'ASC'],
    ['enrolmentCount', 'DESC'],
  ],
  price_desc: [
    ['pricePaise', 'DESC'],
    ['enrolmentCount', 'DESC'],
  ],
};

export async function searchCourses(q: MktCatalogQuery): Promise<MktPage<MktCourseCardDto>> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(48, Math.max(1, q.pageSize ?? 12));
  const and: WhereOptions[] = [LIVE];
  if (q.q?.trim()) {
    const like = `%${escapeLike(q.q.trim())}%`;
    and.push({ [Op.or]: [{ title: { [Op.like]: like } }, { subtitle: { [Op.like]: like } }] });
  }
  if (q.category) {
    const cat = await MktCategory.findOne({ where: { slug: q.category } });
    if (!cat) return { items: [], total: 0, page, pageSize };
    and.push(cat.parentId ? { subcategoryId: cat.id } : { categoryId: cat.id });
  }
  if (q.level) and.push({ level: q.level });
  if (q.language) and.push({ language: q.language });
  if (q.price === 'free') and.push({ pricePaise: 0 });
  if (q.price === 'paid') and.push({ pricePaise: { [Op.gt]: 0 } });
  if (q.rating) and.push({ ratingAvg: { [Op.gte]: q.rating } });
  const sellerWhere: WhereOptions = q.seller ? { status: 'active', slug: q.seller } : { status: 'active' };
  const { rows, count } = await MktCourse.findAndCountAll({
    where: { [Op.and]: and },
    include: [
      { ...liveSeller, where: sellerWhere },
      { model: MktMedia, as: 'thumbnail' },
    ],
    order: [...(ORDER[q.sort ?? 'relevance'] ?? ORDER.relevance), ['id', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    distinct: true,
  });
  return { items: rows.map(toCard), total: count, page, pageSize };
}

export async function home(): Promise<MktHomeDto> {
  const [categories, featured, newest, free] = await Promise.all([
    listCategories(),
    searchCourses({ sort: 'popular', pageSize: 8 }),
    searchCourses({ sort: 'newest', pageSize: 8 }),
    searchCourses({ price: 'free', sort: 'popular', pageSize: 8 }),
  ]);
  return { categories, featured: featured.items, newest: newest.items, free: free.items };
}

async function liveCourse(slug: string) {
  const c = await MktCourse.findOne({ where: { slug, ...LIVE }, include: liveInclude });
  if (!c) throw NotFound('Course');
  return c;
}

const catRef = (c: MktCategory | null) => (c ? { id: c.id, slug: c.slug, name: c.name } : null);

/** Landing page: everything but lecture content (only previews are playable). */
export async function courseDetail(slug: string): Promise<MktCourseDetailDto> {
  const c = await liveCourse(slug);
  const [outline, category, subcategory, promo] = await Promise.all([
    curriculum(c.id),
    c.categoryId ? MktCategory.findByPk(c.categoryId) : null,
    c.subcategoryId ? MktCategory.findByPk(c.subcategoryId) : null,
    c.promoMediaId ? MktMedia.findByPk(c.promoMediaId) : null,
  ]);
  return {
    ...toCard(c),
    description: c.description,
    outcomes: c.outcomes ?? [],
    requirements: c.requirements ?? [],
    audience: c.audience ?? [],
    category: catRef(category),
    subcategory: catRef(subcategory),
    promo: promo ? streamFor(promo, 0) : null,
    sections: outline.map(({ section, lectures }) => ({
      id: section.id,
      title: section.title,
      lectures: lectures.map((l) => ({
        id: l.id,
        title: l.title,
        type: l.type,
        durationSeconds: l.durationSeconds,
        preview: l.preview,
      })),
    })),
    enrolled: false,
    inCart: false,
  };
}

/** Free preview of a lecture of a published course. */
export async function previewLecture(id: number): Promise<{
  id: number;
  title: string;
  type: string;
  articleBody: string | null;
  stream: MktStreamDto | null;
}> {
  const l = await MktLecture.findOne({
    where: { id, preview: true },
    include: [{ model: MktMedia, as: 'media' }],
  });
  if (!l) throw NotFound('Lecture');
  const c = await MktCourse.findOne({ where: { id: l.courseId, ...LIVE }, include: [liveSeller] });
  if (!c) throw NotFound('Lecture');
  return {
    id: l.id,
    title: l.title,
    type: l.type,
    articleBody: l.type === 'article' ? l.articleBody : null,
    stream: l.type === 'video' && l.media ? streamFor(l.media, 0) : null,
  };
}

export async function sellerPage(slug: string): Promise<MktSellerPublicDto> {
  const s = await MktSeller.findOne({
    where: { slug, status: 'active' },
    include: [{ model: MktMedia, as: 'avatar' }],
  });
  if (!s) throw NotFound('Instructor');
  const courses = await MktCourse.findAll({
    where: { sellerId: s.id, ...LIVE },
    include: cardInclude,
    order: [['enrolmentCount', 'DESC']],
  });
  const rated = courses.filter((c) => c.ratingCount > 0);
  const ratingCount = rated.reduce((a, c) => a + c.ratingCount, 0);
  return {
    ...sellerRef(s),
    headline: s.headline,
    bio: s.bio,
    website: s.website,
    courseCount: courses.length,
    studentCount: courses.reduce((a, c) => a + c.enrolmentCount, 0),
    ratingAvg: ratingCount
      ? Math.round((rated.reduce((a, c) => a + c.ratingAvg * c.ratingCount, 0) / ratingCount) * 10) / 10
      : 0,
    ratingCount,
    courses: courses.map(toCard),
  };
}
