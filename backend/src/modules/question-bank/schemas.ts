import { z } from 'zod';
import {
  BANK_VISIBILITIES,
  QUESTION_DIFFICULTIES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  type QuestionInput,
} from '@erp/shared';

const id = z.number().int().positive();
const marks = z.number().min(0).max(1000);

export const optionSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,3}$/)
    .transform((s) => s.toUpperCase()),
  text: z.string().trim().max(2000),
  imageFileId: id.nullable().optional(),
});

export const answerKeySchema = z.object({
  options: z.array(z.string().trim().toUpperCase()).max(10).optional(),
  value: z.union([z.number(), z.boolean()]).optional(),
  tolerance: z.number().min(0).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  modelAnswer: z.string().trim().max(10000).optional(),
  rubric: z.string().trim().max(5000).optional(),
});

const baseQuestion = z.object({
  type: z.enum(QUESTION_TYPES),
  text: z.string().trim().min(1).max(10000),
  options: z.array(optionSchema).max(10).optional(),
  answerKey: answerKeySchema,
  explanation: z.string().trim().max(10000).nullable().optional(),
  difficulty: z.enum(QUESTION_DIFFICULTIES).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  subjectId: id.nullable().optional(),
  chapterId: id.nullable().optional(),
  topicId: id.nullable().optional(),
  defaultMarks: marks.optional(),
  defaultNegativeMarks: marks.optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  source: z.enum(['manual', 'import', 'ai']).optional(),
});

/** Type-specific rules for the options and answer key. Returns an error message or null. */
export function questionShapeError(q: Pick<QuestionInput, 'type' | 'options' | 'answerKey'>): string | null {
  const options = q.options ?? [];
  const keys = options.map((o) => o.key.toUpperCase());
  const correct = q.answerKey.options ?? [];
  switch (q.type) {
    case 'single':
    case 'multiple': {
      if (options.length < 2) return 'MCQ questions need at least two options';
      if (new Set(keys).size !== keys.length) return 'Option keys must be unique';
      if (options.some((o) => !o.text && !o.imageFileId)) return 'Every option needs text or an image';
      if (!correct.length) return 'Select the correct option(s) in the answer key';
      if (correct.some((k) => !keys.includes(k))) return 'Answer key refers to an unknown option';
      if (q.type === 'single' && correct.length !== 1) return 'Single-correct MCQ needs exactly one answer';
      return null;
    }
    case 'true_false':
      return typeof q.answerKey.value === 'boolean' ? null : 'True/false questions need a boolean answer';
    case 'numerical': {
      const { value, min, max } = q.answerKey;
      if (typeof value === 'number') return null;
      if (typeof min === 'number' && typeof max === 'number')
        return min <= max ? null : 'Numerical range minimum must not exceed maximum';
      return 'Numerical questions need a value (with optional tolerance) or a min/max range';
    }
    case 'descriptive':
      return null;
  }
}

export const questionSchema = baseQuestion.superRefine((q, ctx) => {
  const err = questionShapeError(q);
  if (err) ctx.addIssue({ code: 'custom', message: err, path: ['answerKey'] });
});

export const questionPatchSchema = baseQuestion.partial();

export const bankSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(1000).nullable().optional(),
  subjectId: id.nullable().optional(),
  visibility: z.enum(BANK_VISIBILITIES).optional(),
  branchId: id.nullable().optional(),
});

export const generateSchema = z
  .object({
    topicId: id.nullable().optional(),
    topic: z.string().trim().min(2).max(200).optional(),
    type: z.enum(QUESTION_TYPES),
    count: z.number().int().min(1).max(20),
    difficulty: z.enum(QUESTION_DIFFICULTIES).optional(),
    instructions: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.topicId || v.topic, { message: 'Choose a topic or describe one', path: ['topic'] });
