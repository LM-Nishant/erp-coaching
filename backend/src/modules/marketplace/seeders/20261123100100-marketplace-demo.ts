import type { MktCourseLevel, MktLectureType } from '@erp/shared';
import type { Migration } from '../../../infrastructure/database/migration-helpers';
import { config } from '../../../infrastructure/config';
import { hashPassword } from '../../../infrastructure/password';
import { User } from '../../users/user.model';
import { Institute } from '../../institutes/institute.model';
import { MktCategory, MktCoupon, MktCourse, MktLecture, MktSection, MktSeller } from '../models';
import { saveMediaBuffer } from '../media.service';
import { recomputeTotals } from '../courses.service';
import { platformSettings } from '../util';
import { DEMO_THUMBNAILS_JPG, DEMO_VIDEO_MP4 } from './demo-media';

/**
 * Demo marketplace: categories, the Apex storefront, an independent instructor (mobile
 * 9640000001) and a learner (9640000002), published courses with video, article and resource
 * lectures, and two coupons. Idempotent (skips what exists) and writes rows directly, so no
 * notifications or audit entries are produced. Only with SEED_DEMO_DATA=true.
 */
const CATEGORIES: { slug: string; name: string; icon: string; children: [string, string][] }[] = [
  {
    slug: 'development',
    name: 'Development',
    icon: 'code-slash',
    children: [
      ['programming-languages', 'Programming languages'],
      ['web-development', 'Web development'],
    ],
  },
  {
    slug: 'test-prep',
    name: 'Test prep',
    icon: 'school',
    children: [
      ['engineering-entrance', 'Engineering entrance'],
      ['medical-entrance', 'Medical entrance'],
    ],
  },
  {
    slug: 'languages',
    name: 'Languages',
    icon: 'language',
    children: [
      ['english', 'English'],
      ['hindi', 'Hindi'],
    ],
  },
  {
    slug: 'business',
    name: 'Business',
    icon: 'briefcase',
    children: [['communication', 'Communication']],
  },
];

interface DemoLecture {
  title: string;
  type: MktLectureType;
  preview?: boolean;
  body?: string;
}
interface DemoCourse {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  category: string;
  subcategory: string;
  level: MktCourseLevel;
  language: string;
  pricePaise: number;
  thumbnail: number;
  outcomes: string[];
  requirements: string[];
  audience: string[];
  sections: { title: string; lectures: DemoLecture[] }[];
}

const article = (topic: string) =>
  `## ${topic}\n\nThis lesson walks through ${topic.toLowerCase()} step by step.\n\n` +
  `- Read the key ideas\n- Try the worked example\n- Note down one question to revisit\n\n` +
  `Take your time: you can come back to this page whenever you like.`;

const INSTITUTE_COURSES: DemoCourse[] = [
  {
    slug: 'jee-physics-mechanics-masterclass',
    title: 'JEE Physics: Mechanics Masterclass',
    subtitle: 'Kinematics, laws of motion and work-energy, the way toppers learn them',
    description:
      'A complete mechanics course for JEE Main and Advanced aspirants, taught by Apex faculty. ' +
      'Every chapter starts from first principles and ends with exam-level problems.',
    category: 'test-prep',
    subcategory: 'engineering-entrance',
    level: 'intermediate',
    language: 'en',
    pricePaise: 149900,
    thumbnail: 0,
    outcomes: [
      'Solve kinematics problems in one and two dimensions',
      "Apply Newton's laws to connected bodies and pulleys",
      'Use work-energy and momentum to shortcut long problems',
    ],
    requirements: ['Class 11 mathematics (basic calculus helps)'],
    audience: ['JEE Main and Advanced aspirants', 'Class 11 and 12 science students'],
    sections: [
      {
        title: 'Kinematics',
        lectures: [
          { title: 'Welcome and how to use this course', type: 'video', preview: true },
          { title: 'Motion in a straight line', type: 'article', body: article('Motion in a straight line') },
          { title: 'Projectile motion', type: 'video' },
        ],
      },
      {
        title: 'Laws of motion',
        lectures: [
          { title: "Newton's three laws", type: 'video' },
          { title: 'Practice sheet: friction and pulleys', type: 'resource' },
        ],
      },
    ],
  },
  {
    slug: 'neet-biology-crash-course',
    title: 'NEET Biology Crash Course',
    subtitle: 'High-yield botany and zoology revision in 30 days',
    description:
      'Fast, focused revision of the NCERT topics that carry the most marks in NEET, with ' +
      'diagrams and memory tricks.',
    category: 'test-prep',
    subcategory: 'medical-entrance',
    level: 'all',
    language: 'en',
    pricePaise: 99900,
    thumbnail: 2,
    outcomes: ['Revise all high-yield NCERT biology chapters', 'Remember diagrams with simple tricks'],
    requirements: ['NCERT Biology textbooks for classes 11 and 12'],
    audience: ['NEET aspirants in their final revision phase'],
    sections: [
      {
        title: 'Cell biology',
        lectures: [
          { title: 'Cell: the unit of life', type: 'video', preview: true },
          { title: 'Cell division made simple', type: 'article', body: article('Cell division') },
        ],
      },
      {
        title: 'Human physiology',
        lectures: [
          { title: 'Digestion and absorption', type: 'video' },
          { title: 'Physiology summary notes', type: 'resource' },
        ],
      },
    ],
  },
];

const INSTRUCTOR_COURSES: DemoCourse[] = [
  {
    slug: 'python-for-absolute-beginners',
    title: 'Python for Absolute Beginners',
    subtitle: 'Write your first real programs in Python, no experience needed',
    description:
      'Learn to code from zero. We install Python, write small programs together and finish ' +
      'with a mini project you can show your friends.',
    category: 'development',
    subcategory: 'programming-languages',
    level: 'beginner',
    language: 'en',
    pricePaise: 49900,
    thumbnail: 1,
    outcomes: [
      'Write Python programs with variables, loops and functions',
      'Read and write files',
      'Build a small quiz game project',
    ],
    requirements: ['A laptop or desktop computer', 'No programming experience needed'],
    audience: ['Complete beginners', 'Students curious about coding'],
    sections: [
      {
        title: 'Getting started',
        lectures: [
          { title: 'Why Python?', type: 'video', preview: true },
          { title: 'Installing Python', type: 'article', body: article('Installing Python'), preview: true },
        ],
      },
      {
        title: 'Core ideas',
        lectures: [
          { title: 'Variables and types', type: 'video' },
          { title: 'Loops and conditions', type: 'article', body: article('Loops and conditions') },
          { title: 'Cheat sheet', type: 'resource' },
        ],
      },
    ],
  },
  {
    slug: 'spoken-english-confidence-builder',
    title: 'Spoken English Confidence Builder',
    subtitle: 'Everyday conversations, interviews and presentations',
    description: 'Short daily lessons that help you speak English clearly and confidently.',
    category: 'languages',
    subcategory: 'english',
    level: 'beginner',
    language: 'en',
    pricePaise: 0,
    thumbnail: 3,
    outcomes: ['Introduce yourself with confidence', 'Handle common interview questions'],
    requirements: ['Basic reading ability in English'],
    audience: ['Students and job seekers'],
    sections: [
      {
        title: 'Everyday English',
        lectures: [
          { title: 'Introducing yourself', type: 'video', preview: true },
          { title: 'Useful phrases', type: 'article', body: article('Useful everyday phrases') },
        ],
      },
    ],
  },
];

async function seedCourses(seller: MktSeller, defs: DemoCourse[], cats: Map<string, MktCategory>) {
  const video = Buffer.from(DEMO_VIDEO_MP4, 'base64');
  for (const def of defs) {
    if (await MktCourse.findOne({ where: { slug: def.slug } })) continue;
    const thumb = await saveMediaBuffer(seller.id, {
      kind: 'image',
      name: `${def.slug}.jpg`,
      mimeType: 'image/jpeg',
      data: Buffer.from(DEMO_THUMBNAILS_JPG[def.thumbnail], 'base64'),
    });
    const now = new Date();
    const course = await MktCourse.create({
      sellerId: seller.id,
      slug: def.slug,
      title: def.title,
      subtitle: def.subtitle,
      description: def.description,
      categoryId: cats.get(def.category)?.id ?? null,
      subcategoryId: cats.get(def.subcategory)?.id ?? null,
      level: def.level,
      language: def.language,
      pricePaise: def.pricePaise,
      outcomes: def.outcomes,
      requirements: def.requirements,
      audience: def.audience,
      thumbnailMediaId: thumb.id,
      promoMediaId: null,
      status: 'published',
      submittedAt: now,
      reviewedAt: now,
      publishedAt: now,
      createdByUserId: seller.userId,
    });
    let promo: number | null = null;
    for (const [si, s] of def.sections.entries()) {
      const section = await MktSection.create({ courseId: course.id, title: s.title, sortOrder: si });
      for (const [li, l] of s.lectures.entries()) {
        let mediaId: number | null = null;
        let durationSeconds = 0;
        if (l.type === 'video') {
          const m = await saveMediaBuffer(seller.id, {
            kind: 'video',
            name: `${l.title}.mp4`,
            mimeType: 'video/mp4',
            data: video,
            durationSeconds: 6,
          });
          mediaId = m.id;
          durationSeconds = 6;
          promo ??= m.id;
        } else if (l.type === 'resource') {
          const m = await saveMediaBuffer(seller.id, {
            kind: 'file',
            name: `${l.title}.txt`,
            mimeType: 'text/plain',
            data: Buffer.from(
              `${def.title}\n${l.title}\n\nDemo resource: practise these at your own pace.\n`,
            ),
          });
          mediaId = m.id;
        } else {
          durationSeconds = 120;
        }
        await MktLecture.create({
          courseId: course.id,
          sectionId: section.id,
          title: l.title,
          type: l.type,
          description: null,
          articleBody: l.body ?? null,
          mediaId,
          preview: l.preview ?? false,
          durationSeconds,
          sortOrder: li,
        });
      }
    }
    await course.update({ promoMediaId: promo });
    await recomputeTotals(course.id);
  }
}

export const up: Migration = async () => {
  await platformSettings();
  if (!config.SEED_DEMO_DATA) return;

  const cats = new Map<string, MktCategory>();
  for (const [i, c] of CATEGORIES.entries()) {
    const [parent] = await MktCategory.findOrCreate({
      where: { slug: c.slug },
      defaults: { slug: c.slug, name: c.name, icon: c.icon, parentId: null, sortOrder: i },
    });
    cats.set(c.slug, parent);
    for (const [j, [slug, name]] of c.children.entries()) {
      const [child] = await MktCategory.findOrCreate({
        where: { slug },
        defaults: { slug, name, icon: null, parentId: parent.id, sortOrder: j },
      });
      cats.set(slug, child);
    }
  }

  const demoHash = await hashPassword(config.SEED_DEMO_PASSWORD);
  const user = async (mobile: string, name: string, email: string) =>
    (
      await User.findOrCreate({
        where: { mobile },
        defaults: { mobile, name, email, passwordHash: demoHash, isSuperAdmin: false, lastLoginAt: null },
      })
    )[0];
  const riya = await user('9640000001', 'Riya Sharma', 'riya.instructor@example.com');
  await user('9640000002', 'Aarav Learner', 'aarav.learner@example.com');

  const [instructor] = await MktSeller.findOrCreate({
    where: { userId: riya.id },
    defaults: {
      type: 'instructor',
      slug: 'riya-sharma',
      displayName: 'Riya Sharma',
      headline: 'Software engineer and friendly coding teacher',
      bio: 'Riya has taught programming and spoken English to over 5,000 students across India.',
      website: null,
      avatarMediaId: null,
      ownerInstituteId: null,
      userId: riya.id,
      commissionPercent: null,
    },
  });
  await seedCourses(instructor, INSTRUCTOR_COURSES, cats);

  const apex = await Institute.findOne({ where: { slug: 'apex' } });
  if (apex) {
    const [store] = await MktSeller.findOrCreate({
      where: { ownerInstituteId: apex.id },
      defaults: {
        type: 'institute',
        slug: 'apex-coaching-classes',
        displayName: apex.name,
        headline: 'JEE and NEET coaching from Pune since 2009',
        bio: 'Apex Coaching Classes brings its classroom programmes to learners everywhere.',
        website: null,
        avatarMediaId: null,
        ownerInstituteId: apex.id,
        userId: null,
        commissionPercent: 20,
      },
    });
    await seedCourses(store, INSTITUTE_COURSES, cats);
  }

  await MktCoupon.findOrCreate({
    where: { code: 'WELCOME20' },
    defaults: {
      code: 'WELCOME20',
      sellerId: null,
      kind: 'percent',
      value: 20,
      courseIds: [],
      maxUses: null,
      validFrom: null,
      validUntil: null,
      createdByUserId: null,
    },
  });
  await MktCoupon.findOrCreate({
    where: { code: 'RIYA100' },
    defaults: {
      code: 'RIYA100',
      sellerId: instructor.id,
      kind: 'amount',
      value: 10000,
      courseIds: [],
      maxUses: 100,
      validFrom: null,
      validUntil: null,
      createdByUserId: riya.id,
    },
  });
};

export const down: Migration = async () => {};
