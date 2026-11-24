import type { Migration } from '../../../infrastructure/database/migration-helpers';
import { config } from '../../../infrastructure/config';
import { hashPassword } from '../../../infrastructure/password';
import { User } from '../../users/user.model';
import { MktAnswer, MktQuestion, MktReview, MktWishlistItem } from '../engagement.models';
import { MktCourse, MktEnrolment, MktLecture, MktSeller } from '../models';
import { recomputeRating } from '../reviews.service';

/**
 * Demo reviews, Q&A and a wishlist on the demo marketplace courses: four reviewer learners
 * (mobiles 9640000011-14) are enrolled and leave ratings; the instructor replies and answers.
 * Rows are written directly, so no notifications are sent. Idempotent. Only with SEED_DEMO_DATA=true.
 */
const REVIEWERS: [string, string][] = [
  ['9640000011', 'Meera Iyer'],
  ['9640000012', 'Kabir Singh'],
  ['9640000013', 'Sana Qureshi'],
  ['9640000014', 'Rohan Das'],
];

const REVIEWS: Record<string, [number, string, string][]> = {
  'python-for-absolute-beginners': [
    [
      5,
      'Perfect first course',
      'Clear explanations and the exercises build up nicely. I wrote my first script on day two.',
    ],
    [5, 'Loved the pace', 'Short lectures, no fluff. The article notes are great for revision.'],
    [4, 'Very good', 'Would love a few more practice problems at the end of each section.'],
    [4, 'Great for beginners', 'Exactly what I needed before college.'],
  ],
  'spoken-english-confidence-builder': [
    [5, 'Confidence boost', 'The daily speaking drills really helped me in interviews.'],
    [4, 'Practical', 'Useful phrases for office conversations.'],
    [3, 'Good but short', 'I expected more lessons on pronunciation.'],
  ],
  'jee-physics-mechanics-masterclass': [
    [5, 'Mechanics finally makes sense', 'The free-body diagram approach cleared all my doubts.'],
    [4, 'Solid problem solving', 'Tough problems, well explained.'],
  ],
  'neet-biology-crash-course': [[5, 'Excellent revision', 'Covered the NCERT points that matter most.']],
};

const REPLIES: Record<string, string> = {
  'Very good': 'Thank you! A practice pack is coming in the next update.',
  'Good but short': 'Thanks for the feedback, a pronunciation section is on its way.',
};

const QUESTIONS: Record<string, { title: string; body: string; answer: string; byInstructor: boolean }[]> = {
  'python-for-absolute-beginners': [
    {
      title: 'Which Python version should I install?',
      body: 'My laptop already has Python 3.8. Is that fine for this course?',
      answer: 'Any Python 3.10 or newer is ideal, but 3.8 works for everything in this course.',
      byInstructor: true,
    },
    {
      title: 'Difference between a list and a tuple?',
      body: 'When should I use one over the other?',
      answer:
        'Use a tuple when the values should not change, e.g. coordinates. Lists are for collections you edit.',
      byInstructor: false,
    },
  ],
  'spoken-english-confidence-builder': [
    {
      title: 'How long should I practise every day?',
      body: 'I have about 20 minutes a day. Is that enough?',
      answer: '20 focused minutes daily is great. Repeat each drill aloud twice.',
      byInstructor: true,
    },
  ],
};

export const up: Migration = async () => {
  if (!config.SEED_DEMO_DATA) return;
  const hash = await hashPassword(config.SEED_DEMO_PASSWORD);
  const reviewers: User[] = [];
  for (const [mobile, name] of REVIEWERS)
    reviewers.push(
      (
        await User.findOrCreate({
          where: { mobile },
          defaults: { mobile, name, email: null, passwordHash: hash, isSuperAdmin: false, lastLoginAt: null },
        })
      )[0],
    );

  const enrol = async (userId: number, courseId: number) => {
    const [, created] = await MktEnrolment.findOrCreate({
      where: { userId, courseId },
      defaults: { userId, courseId, orderId: null, source: 'grant' },
    });
    if (created) await MktCourse.increment('enrolmentCount', { where: { id: courseId } });
  };

  for (const [slug, reviews] of Object.entries(REVIEWS)) {
    const course = await MktCourse.findOne({
      where: { slug },
      include: [{ model: MktSeller, as: 'seller' }],
    });
    if (!course) continue;
    const replier = course.seller?.userId ?? course.createdByUserId;
    for (const [i, [rating, title, body]] of reviews.entries()) {
      const user = reviewers[i % reviewers.length];
      await enrol(user.id, course.id);
      const reply = REPLIES[title];
      await MktReview.findOrCreate({
        where: { courseId: course.id, userId: user.id },
        defaults: {
          courseId: course.id,
          userId: user.id,
          rating,
          title,
          body,
          ...(reply && replier ? { replyBody: reply, replyByUserId: replier, repliedAt: new Date() } : {}),
        },
      });
    }
    await recomputeRating(course.id);

    for (const [i, q] of (QUESTIONS[slug] ?? []).entries()) {
      const asker = reviewers[i % reviewers.length];
      if (await MktQuestion.count({ where: { courseId: course.id, title: q.title } })) continue;
      const lecture = await MktLecture.findOne({
        where: { courseId: course.id },
        order: [
          ['sortOrder', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      const question = await MktQuestion.create({
        courseId: course.id,
        lectureId: i === 0 ? (lecture?.id ?? null) : null,
        userId: asker.id,
        title: q.title,
        body: q.body,
        answered: true,
        answerCount: 1,
      });
      const answerer = q.byInstructor ? replier : reviewers[(i + 1) % reviewers.length].id;
      if (answerer)
        await MktAnswer.create({
          questionId: question.id,
          userId: answerer,
          body: q.answer,
          isInstructor: q.byInstructor,
        });
    }
  }

  // The demo learner (9640000002) has two courses saved for later.
  const learner = await User.findOne({ where: { mobile: '9640000002' } });
  if (learner)
    for (const slug of ['jee-physics-mechanics-masterclass', 'spoken-english-confidence-builder']) {
      const c = await MktCourse.findOne({ where: { slug }, attributes: ['id'] });
      if (c)
        await MktWishlistItem.findOrCreate({
          where: { userId: learner.id, courseId: c.id },
          defaults: { userId: learner.id, courseId: c.id },
        });
    }
};

export const down: Migration = async () => {};
