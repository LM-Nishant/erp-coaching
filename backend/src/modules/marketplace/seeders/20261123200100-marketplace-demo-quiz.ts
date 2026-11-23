import type { Migration } from '../../../infrastructure/database/migration-helpers';
import { config } from '../../../infrastructure/config';
import { MktCourse, MktLecture, MktSection } from '../models';
import { MktQuiz, MktQuizQuestion } from '../quiz-models';
import { recomputeTotals } from '../courses.service';

/**
 * Demo quiz: adds a "Check your understanding" quiz lecture to the end of the demo Python
 * course. Idempotent and writes rows directly, so no notifications are sent.
 * Only with SEED_DEMO_DATA=true.
 */
const COURSE_SLUG = 'python-for-absolute-beginners';
const TITLE = 'Check your understanding';

const QUESTIONS = [
  {
    kind: 'single' as const,
    prompt: 'Which function prints text to the screen in Python?',
    options: [
      { key: 'A', text: 'echo()' },
      { key: 'B', text: 'print()' },
      { key: 'C', text: 'console.log()' },
      { key: 'D', text: 'write()' },
    ],
    correct: ['B'],
    explanation: 'print() writes its arguments to standard output.',
  },
  {
    kind: 'multi' as const,
    prompt: 'Which of these are valid Python loop keywords?',
    options: [
      { key: 'A', text: 'for' },
      { key: 'B', text: 'while' },
      { key: 'C', text: 'repeat' },
      { key: 'D', text: 'loop' },
    ],
    correct: ['A', 'B'],
    explanation: 'Python has for and while loops; repeat and loop are not keywords.',
  },
  {
    kind: 'single' as const,
    prompt: 'What is the type of the value 3.14?',
    options: [
      { key: 'A', text: 'int' },
      { key: 'B', text: 'str' },
      { key: 'C', text: 'float' },
    ],
    correct: ['C'],
    explanation: 'Numbers with a decimal point are floats.',
  },
];

export const up: Migration = async () => {
  if (!config.SEED_DEMO_DATA) return;
  const course = await MktCourse.findOne({ where: { slug: COURSE_SLUG } });
  if (!course) return;
  if (await MktLecture.findOne({ where: { courseId: course.id, type: 'quiz' } })) return;
  const section = await MktSection.findOne({
    where: { courseId: course.id },
    order: [['sortOrder', 'DESC']],
  });
  if (!section) return;
  const last = await MktLecture.max<number, MktLecture>('sortOrder', { where: { sectionId: section.id } });
  const lecture = await MktLecture.create({
    courseId: course.id,
    sectionId: section.id,
    title: TITLE,
    type: 'quiz',
    description: 'Three quick questions on the basics. Score 70% to pass.',
    articleBody: null,
    mediaId: null,
    preview: false,
    durationSeconds: 180,
    sortOrder: (last ?? -1) + 1,
  });
  await MktQuiz.create({ lectureId: lecture.id, passPercent: 70, maxAttempts: null, shuffle: false });
  await MktQuizQuestion.bulkCreate(QUESTIONS.map((q, i) => ({ ...q, lectureId: lecture.id, sortOrder: i })));
  await recomputeTotals(course.id);
};

export const down: Migration = async () => {};
