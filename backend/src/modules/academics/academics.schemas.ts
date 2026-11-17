import { z } from 'zod';
import { COURSE_MODES, DURATION_UNITS } from '@erp/shared';

const isValidDate = (s: string) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isValidDate, 'Invalid date');
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');
export const idNum = z.coerce.number().int().positive();
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const sessionBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    startDate: dateStr,
    endDate: dateStr,
    status: z.enum(['planned', 'active', 'closed']).optional(),
  })
  .refine((v) => v.endDate > v.startDate, { message: 'endDate must be after startDate', path: ['endDate'] });

export const sessionPatch = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  startDate: dateStr.optional(),
  endDate: dateStr.optional(),
  status: z.enum(['planned', 'active', 'closed']).optional(),
});

export const categoryBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: optText(2000),
});

export const courseBody = z.object({
  name: z.string().trim().min(2).max(150),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/),
  categoryId: idNum.nullable().optional(),
  description: optText(5000),
  mode: z.enum(COURSE_MODES).optional(),
  durationValue: z.number().int().positive().max(1000).nullable().optional(),
  durationUnit: z.enum(DURATION_UNITS).nullable().optional(),
  isTemplate: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
  branchIds: z.array(idNum).max(200).optional(),
  subjectIds: z.array(idNum).max(200).optional(),
});

export const cloneBody = z.object({
  name: z.string().trim().min(2).max(150),
  code: courseBody.shape.code,
  branchIds: z.array(idNum).max(200).optional(),
  isTemplate: z.boolean().optional(),
});

export const subjectBody = z.object({
  name: z.string().trim().min(1).max(120),
  code: optText(30),
});

export const chapterBody = z.object({
  subjectId: idNum,
  name: z.string().trim().min(1).max(150),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

export const topicBody = z.object({
  chapterId: idNum,
  name: z.string().trim().min(1).max(150),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  durationMinutes: z.number().int().positive().max(100000).nullable().optional(),
});

export const batchBody = z.object({
  branchId: idNum,
  courseId: idNum,
  academicSessionId: idNum,
  name: z.string().trim().min(2).max(120),
  code: courseBody.shape.code,
  capacity: z.number().int().positive().max(10000),
  startDate: dateStr,
  endDate: dateStr.nullable().optional(),
  mode: z.enum(COURSE_MODES).optional(),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']).optional(),
  teachers: z
    .array(z.object({ teacherUserId: idNum, subjectId: idNum.nullable().optional() }))
    .max(100)
    .optional(),
});

export const teachersBody = z.object({
  teachers: z.array(z.object({ teacherUserId: idNum, subjectId: idNum.nullable().optional() })).max(100),
});

export const enrollBody = z.object({
  studentUserIds: z.array(idNum).min(1).max(500),
  joinedOn: dateStr.optional(),
});

export const promotionBody = z.object({
  fromBatchId: idNum,
  toBatchId: idNum,
  studentUserIds: z.array(idNum).min(1).max(1000).optional(),
});

export const classroomBody = z.object({
  branchId: idNum,
  name: z.string().trim().min(1).max(80),
  capacity: z.number().int().positive().max(10000),
  isVirtual: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const scheduleBody = z.object({
  batchId: idNum,
  subjectId: idNum.nullable().optional(),
  teacherUserId: idNum,
  classroomId: idNum.nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeStr,
  endTime: timeStr,
  effectiveFrom: dateStr,
  effectiveTo: dateStr.nullable().optional(),
});

export const generateBody = z.object({ from: dateStr, to: dateStr, batchId: idNum.optional() });

export const classSessionBody = z.object({
  batchId: idNum,
  subjectId: idNum.nullable().optional(),
  teacherUserId: idNum,
  classroomId: idNum.nullable().optional(),
  date: dateStr,
  startTime: timeStr,
  endTime: timeStr,
});

export const classSessionQuery = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  batchId: idNum.optional(),
  teacherUserId: idNum.optional(),
  classroomId: idNum.optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const rescheduleBody = z.object({
  date: dateStr,
  startTime: timeStr,
  endTime: timeStr,
  classroomId: idNum.nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const cancelBody = z.object({ reason: z.string().trim().min(2).max(500) });
export const substituteBody = z.object({ teacherUserId: idNum });
export const completeBody = z.object({
  actualDurationMinutes: z.number().int().min(1).max(1440),
  completionNotes: optText(5000),
});

export const noteBody = z
  .object({
    kind: z.enum(['note', 'homework']).default('note'),
    title: z.string().trim().min(1).max(200),
    body: optText(20000),
    dueDate: dateStr.nullable().optional(),
    fileIds: z.array(idNum).max(20).optional(),
  })
  .refine((v) => v.kind === 'homework' || !v.dueDate, {
    message: 'Only homework can have a due date',
    path: ['dueDate'],
  });

export const notePatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: optText(20000),
  dueDate: dateStr.nullable().optional(),
  fileIds: z.array(idNum).max(20).optional(),
});

export const commentBody = z.object({ body: z.string().trim().min(1).max(2000) });
