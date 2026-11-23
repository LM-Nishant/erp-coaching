import { Op, ForeignKeyConstraintError, type WhereOptions } from 'sequelize';
import {
  QUESTION_IMPORT_COLUMNS,
  type AnswerKey,
  type GenerateQuestionsInput,
  type GeneratedQuestionsDto,
  type QuestionBankDto,
  type QuestionBankInput,
  type QuestionDifficulty,
  type QuestionDto,
  type QuestionImportResult,
  type QuestionInput,
  type QuestionStatus,
  type QuestionType,
} from '@erp/shared';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { hasPermission, requireTenantContext } from '../../shared/context';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { paginated, toLimitOffset } from '../../shared/utilities/pagination';
import { fileRepo, saveUploadedFile, signedUrlFor } from '../files/files.service';
import { FileObject } from '../files/file.model';
import { User } from '../users/user.model';
import { aiChat } from '../ai/ai.service';
import { Chapter, Subject, Topic } from '../academics/api';
import { Question, QuestionAsset, QuestionBank } from './models';
import { questionSchema, questionShapeError } from './schemas';
import { parseSpreadsheet, toCsv } from './spreadsheet';

export const MODULE = 'question-bank';

export const bankRepo = new TenantRepository(QuestionBank, {
  branchScoped: true,
  instituteWideRows: true,
  entity: 'Question bank',
});
export const questionRepo = new TenantRepository(Question, { entity: 'Question' });
export const assetRepo = new TenantRepository(QuestionAsset, { entity: 'Question asset' });
const subjectRepo = new TenantRepository(Subject, { entity: 'Subject' });
const chapterRepo = new TenantRepository(Chapter, { entity: 'Chapter' });
const topicRepo = new TenantRepository(Topic, { entity: 'Topic' });

export const isManager = () => hasPermission(`${MODULE}.configure`);
export const me = () => requireTenantContext().userId ?? null;

/** Banks the current user may see/reuse: shared banks plus their own private banks (managers see all). */
function visibleBankWhere(): WhereOptions<QuestionBank> {
  if (isManager() || requireTenantContext().system) return {};
  return { [Op.or]: [{ visibility: 'shared' }, { ownerUserId: me() }] } as WhereOptions<QuestionBank>;
}

export async function findVisibleBank(id: number): Promise<QuestionBank> {
  const bank = await bankRepo.findOne({ where: { id, ...visibleBankWhere() } as WhereOptions<QuestionBank> });
  if (!bank) throw NotFound('Question bank');
  return bank;
}

function canEditBank(bank: QuestionBank): boolean {
  return isManager() || (bank.ownerUserId !== null && bank.ownerUserId === me());
}

export async function findEditableBank(id: number): Promise<QuestionBank> {
  const bank = await findVisibleBank(id);
  if (!canEditBank(bank)) throw Forbidden('Only the bank owner or a question-bank manager can change it');
  bankRepo.assertRowWritable(bank);
  return bank;
}

function bankDto(b: QuestionBank, questionCount?: number): QuestionBankDto {
  return {
    id: b.id,
    branchId: b.branchId,
    name: b.name,
    description: b.description,
    subjectId: b.subjectId,
    subjectName: b.subject?.name ?? null,
    visibility: b.visibility,
    ownerUserId: b.ownerUserId,
    ownerName: b.owner?.name ?? null,
    questionCount,
    canEdit: canEditBank(b),
    createdAt: b.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------- banks

export async function listBanks(filter: { subjectId?: number; q?: string }): Promise<QuestionBankDto[]> {
  const where: Record<string | symbol, unknown> = { ...visibleBankWhere() };
  if (filter.subjectId) where.subjectId = filter.subjectId;
  if (filter.q) where.name = { [Op.like]: `%${filter.q}%` };
  const banks = await bankRepo.findAll({
    where: where as WhereOptions<QuestionBank>,
    include: [
      { model: User, as: 'owner', attributes: ['id', 'name'] },
      { model: Subject, as: 'subject', attributes: ['id', 'name'] },
    ],
    order: [['name', 'ASC']],
  });
  const counts = banks.length
    ? ((await Question.count({
        where: { instituteId: requireTenantContext().instituteId, bankId: banks.map((b) => b.id) },
        group: ['bankId'],
      })) as unknown as { bankId: number; count: number }[])
    : [];
  const byBank = new Map(counts.map((c) => [c.bankId, Number(c.count)]));
  return banks.map((b) => bankDto(b, byBank.get(b.id) ?? 0));
}

export async function getBank(id: number): Promise<QuestionBankDto> {
  await findVisibleBank(id);
  const bank = await bankRepo.findById(id, {
    include: [
      { model: User, as: 'owner', attributes: ['id', 'name'] },
      { model: Subject, as: 'subject', attributes: ['id', 'name'] },
    ],
  });
  return bankDto(bank, await questionRepo.count({ bankId: id }));
}

export async function createBank(input: QuestionBankInput): Promise<QuestionBankDto> {
  if (input.subjectId) await subjectRepo.findById(input.subjectId);
  const bank = await bankRepo.create({
    name: input.name,
    description: input.description ?? null,
    subjectId: input.subjectId ?? null,
    visibility: input.visibility ?? 'shared',
    branchId: input.branchId ?? null,
    ownerUserId: me(),
  });
  await audit({ action: 'question_bank.created', entityType: 'question_bank', entityId: bank.id });
  return getBank(bank.id);
}

export async function updateBank(id: number, input: Partial<QuestionBankInput>): Promise<QuestionBankDto> {
  await findEditableBank(id);
  if (input.subjectId) await subjectRepo.findById(input.subjectId);
  await bankRepo.update(id, input);
  await audit({
    action: 'question_bank.updated',
    entityType: 'question_bank',
    entityId: id,
    metadata: input,
  });
  return getBank(id);
}

export async function deleteBank(id: number): Promise<void> {
  await findEditableBank(id);
  if (await questionRepo.count({ bankId: id }))
    throw Conflict('Delete or move the questions in this bank first', 'BANK_NOT_EMPTY');
  await bankRepo.destroy(id);
  await audit({ action: 'question_bank.deleted', entityType: 'question_bank', entityId: id });
}

// ---------------------------------------------------------------- questions

const questionIncludes = () => [
  { model: Chapter, as: 'chapter', attributes: ['id', 'name'] },
  { model: Topic, as: 'topic', attributes: ['id', 'name'] },
  { model: QuestionAsset, as: 'assets', include: [{ model: FileObject, as: 'file' }] },
];

/** Signs option images in bulk. */
async function optionImageUrls(questions: Question[]): Promise<Map<number, string>> {
  const ids = [
    ...new Set(questions.flatMap((q) => (q.options ?? []).map((o) => o.imageFileId).filter(Boolean))),
  ] as number[];
  if (!ids.length) return new Map();
  const files = await fileRepo.findAll({ where: { id: ids } });
  return new Map(files.map((f) => [f.id, signedUrlFor(f).url]));
}

export function questionDto(q: Question, imageUrls = new Map<number, string>()): QuestionDto {
  return {
    id: q.id,
    bankId: q.bankId,
    type: q.type,
    text: q.text,
    options: (q.options ?? []).map((o) => ({
      ...o,
      imageUrl: o.imageFileId ? (imageUrls.get(o.imageFileId) ?? null) : null,
    })),
    answerKey: q.answerKey,
    explanation: q.explanation,
    difficulty: q.difficulty,
    tags: q.tags ?? [],
    subjectId: q.subjectId,
    chapterId: q.chapterId,
    topicId: q.topicId,
    chapterName: q.chapter?.name ?? null,
    topicName: q.topic?.name ?? null,
    defaultMarks: q.defaultMarks,
    defaultNegativeMarks: q.defaultNegativeMarks,
    status: q.status,
    source: q.source,
    assets: [...(q.assets ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((a) => ({
        id: a.id,
        fileId: a.fileId,
        role: a.role,
        url: a.file ? signedUrlFor(a.file).url : '',
        originalName: a.file?.originalName ?? '',
      })),
    createdByUserId: q.createdByUserId,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

export async function questionDtos(questions: Question[]): Promise<QuestionDto[]> {
  const urls = await optionImageUrls(questions);
  return questions.map((q) => questionDto(q, urls));
}

export interface QuestionFilter {
  page: number;
  pageSize: number;
  bankId?: number;
  type?: QuestionType;
  difficulty?: QuestionDifficulty;
  status?: QuestionStatus;
  subjectId?: number;
  chapterId?: number;
  topicId?: number;
  tag?: string;
  q?: string;
}

/** Ids of banks visible to the current user (for reuse checks and listings). */
export async function visibleBankIds(): Promise<number[]> {
  const banks = await bankRepo.findAll({ where: visibleBankWhere(), attributes: ['id'] });
  return banks.map((b) => b.id);
}

export async function listQuestions(f: QuestionFilter) {
  const bankIds = f.bankId ? [(await findVisibleBank(f.bankId)).id] : await visibleBankIds();
  const where: Record<string | symbol, unknown> = { bankId: bankIds };
  if (f.type) where.type = f.type;
  if (f.difficulty) where.difficulty = f.difficulty;
  where.status = f.status ?? { [Op.ne]: 'archived' };
  if (f.subjectId) where.subjectId = f.subjectId;
  if (f.chapterId) where.chapterId = f.chapterId;
  if (f.topicId) where.topicId = f.topicId;
  if (f.q) where.text = { [Op.like]: `%${f.q}%` };
  if (f.tag)
    where[Op.and as unknown as string] = [
      Question.sequelize!.literal(
        `JSON_CONTAINS(tags, ${Question.sequelize!.escape(JSON.stringify(f.tag))})`,
      ),
    ];
  const { rows, count } = await questionRepo.findAndCountAll({
    where: where as WhereOptions<Question>,
    include: questionIncludes(),
    order: [['id', 'DESC']],
    ...toLimitOffset(f),
  });
  return paginated(await questionDtos(rows), count, f);
}

/** Loads questions the current user may reuse (visible banks). Throws if any id is not visible. */
export async function loadReusableQuestions(ids: number[]): Promise<Question[]> {
  if (!ids.length) return [];
  const rows = await questionRepo.findAll({
    where: { id: ids, bankId: await visibleBankIds() } as WhereOptions<Question>,
    include: questionIncludes(),
  });
  if (rows.length !== new Set(ids).size) throw NotFound('Question');
  return rows;
}

export async function getQuestion(id: number): Promise<QuestionDto> {
  const q = await questionRepo.findById(id, { include: questionIncludes() });
  await findVisibleBank(q.bankId);
  return (await questionDtos([q]))[0];
}

/** Validates academics references and fills subject from chapter/topic when omitted. */
async function resolveAcademics(input: {
  subjectId?: number | null;
  chapterId?: number | null;
  topicId?: number | null;
}) {
  let { subjectId = null, chapterId = null } = input;
  const topicId = input.topicId ?? null;
  if (topicId) {
    const topic = await topicRepo.findById(topicId);
    if (chapterId && chapterId !== topic.chapterId) throw BadRequest('Topic does not belong to the chapter');
    chapterId = topic.chapterId;
  }
  if (chapterId) {
    const chapter = await chapterRepo.findById(chapterId);
    if (subjectId && subjectId !== chapter.subjectId)
      throw BadRequest('Chapter does not belong to the subject');
    subjectId = chapter.subjectId;
  }
  if (subjectId) await subjectRepo.findById(subjectId);
  return { subjectId, chapterId, topicId };
}

async function assertOptionImages(input: Pick<QuestionInput, 'options'>) {
  const ids = (input.options ?? []).map((o) => o.imageFileId).filter(Boolean) as number[];
  if (!ids.length) return;
  const found = await fileRepo.count({ id: ids });
  if (found !== new Set(ids).size) throw NotFound('Option image');
}

function normaliseOptions(options: QuestionInput['options']) {
  return (options ?? []).map((o) => ({
    key: o.key.toUpperCase(),
    text: o.text,
    ...(o.imageFileId ? { imageFileId: o.imageFileId } : {}),
  }));
}

function normaliseKey(type: QuestionType, key: AnswerKey): AnswerKey {
  switch (type) {
    case 'single':
    case 'multiple':
      return { options: [...new Set((key.options ?? []).map((k) => k.toUpperCase()))].sort() };
    case 'true_false':
      return { value: key.value };
    case 'numerical':
      return typeof key.value === 'number'
        ? { value: key.value, tolerance: key.tolerance ?? 0 }
        : { min: key.min, max: key.max };
    case 'descriptive':
      return {
        ...(key.modelAnswer ? { modelAnswer: key.modelAnswer } : {}),
        ...(key.rubric ? { rubric: key.rubric } : {}),
      };
  }
}

export async function buildQuestionValues(input: QuestionInput, bank: QuestionBank) {
  await assertOptionImages(input);
  const acad = await resolveAcademics({
    subjectId: input.subjectId ?? (input.chapterId || input.topicId ? null : bank.subjectId),
    chapterId: input.chapterId,
    topicId: input.topicId,
  });
  return {
    type: input.type,
    text: input.text,
    options: ['single', 'multiple'].includes(input.type) ? normaliseOptions(input.options) : null,
    answerKey: normaliseKey(input.type, input.answerKey),
    explanation: input.explanation ?? null,
    difficulty: input.difficulty ?? 'medium',
    tags: input.tags?.length ? [...new Set(input.tags)] : null,
    ...acad,
    defaultMarks: input.defaultMarks ?? 1,
    defaultNegativeMarks: input.defaultNegativeMarks ?? 0,
    status: input.status ?? 'active',
  };
}

export async function createQuestion(bankId: number, input: QuestionInput): Promise<QuestionDto> {
  const bank = await findEditableBank(bankId);
  const q = await questionRepo.create({
    bankId: bank.id,
    ...(await buildQuestionValues(input, bank)),
    source: input.source ?? 'manual',
    createdByUserId: me(),
  });
  await audit({ action: 'question.created', entityType: 'question', entityId: q.id, metadata: { bankId } });
  return getQuestion(q.id);
}

export async function createQuestions(bankId: number, inputs: QuestionInput[]): Promise<QuestionDto[]> {
  const bank = await findEditableBank(bankId);
  const ids: number[] = [];
  for (const input of inputs) {
    const q = await questionRepo.create({
      bankId: bank.id,
      ...(await buildQuestionValues(input, bank)),
      source: input.source ?? 'manual',
      createdByUserId: me(),
    });
    ids.push(q.id);
  }
  await audit({
    action: 'question.bulk_created',
    entityType: 'question_bank',
    entityId: bankId,
    metadata: { count: ids.length },
  });
  const rows = await questionRepo.findAll({
    where: { id: ids },
    include: questionIncludes(),
    order: [['id', 'ASC']],
  });
  return questionDtos(rows);
}

export async function updateQuestion(id: number, patch: Partial<QuestionInput>): Promise<QuestionDto> {
  const q = await questionRepo.findById(id);
  const bank = await findEditableBank(q.bankId);
  const merged: QuestionInput = {
    type: patch.type ?? q.type,
    text: patch.text ?? q.text,
    options: patch.options ?? q.options ?? undefined,
    answerKey: patch.answerKey ?? q.answerKey,
    explanation: patch.explanation !== undefined ? patch.explanation : q.explanation,
    difficulty: patch.difficulty ?? q.difficulty,
    tags: patch.tags ?? q.tags ?? undefined,
    subjectId: patch.subjectId !== undefined ? patch.subjectId : q.subjectId,
    chapterId: patch.chapterId !== undefined ? patch.chapterId : q.chapterId,
    topicId: patch.topicId !== undefined ? patch.topicId : q.topicId,
    defaultMarks: patch.defaultMarks ?? q.defaultMarks,
    defaultNegativeMarks: patch.defaultNegativeMarks ?? q.defaultNegativeMarks,
    status: patch.status ?? q.status,
  };
  if (patch.topicId !== undefined && patch.chapterId === undefined) merged.chapterId = null;
  if ((patch.chapterId !== undefined || patch.topicId !== undefined) && patch.subjectId === undefined)
    merged.subjectId = null;
  const err = questionShapeError(merged);
  if (err) throw BadRequest(err);
  const values = await buildQuestionValues(merged, bank);
  if (!values.subjectId && q.subjectId && patch.subjectId === undefined && !values.chapterId)
    values.subjectId = q.subjectId;
  await q.update(values);
  await audit({
    action: 'question.updated',
    entityType: 'question',
    entityId: id,
    metadata: { fields: Object.keys(patch) },
  });
  return getQuestion(id);
}

export async function deleteQuestion(id: number): Promise<void> {
  const q = await questionRepo.findById(id);
  await findEditableBank(q.bankId);
  try {
    await q.destroy();
  } catch (err) {
    if (err instanceof ForeignKeyConstraintError)
      throw Conflict('This question is used in an exam; archive it instead', 'QUESTION_IN_USE');
    throw err;
  }
  await audit({ action: 'question.deleted', entityType: 'question', entityId: id });
}

// ---------------------------------------------------------------- assets

export async function addAsset(
  questionId: number,
  file: Express.Multer.File,
  role: 'question' | 'explanation',
): Promise<QuestionDto> {
  const q = await questionRepo.findById(questionId);
  const bank = await findEditableBank(q.bankId);
  if (!file.mimetype.startsWith('image/')) throw BadRequest('Question assets must be images');
  const saved = await saveUploadedFile({
    tempPath: file.path,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    module: MODULE,
    branchId: bank.branchId,
  });
  const sortOrder = await assetRepo.count({ questionId });
  await assetRepo.create({ questionId, fileId: saved.id, role, sortOrder });
  await audit({
    action: 'question.asset_added',
    entityType: 'question',
    entityId: questionId,
    metadata: { fileId: saved.id },
  });
  return getQuestion(questionId);
}

/** Uploads an image for use as an MCQ option picture; returns the file id + preview URL. */
export async function uploadOptionImage(bankId: number, file: Express.Multer.File) {
  const bank = await findEditableBank(bankId);
  if (!file.mimetype.startsWith('image/')) throw BadRequest('Option images must be images');
  const saved = await saveUploadedFile({
    tempPath: file.path,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    module: MODULE,
    branchId: bank.branchId,
  });
  return { fileId: saved.id, url: signedUrlFor(saved).url };
}

export async function removeAsset(questionId: number, assetId: number): Promise<QuestionDto> {
  const q = await questionRepo.findById(questionId);
  await findEditableBank(q.bankId);
  const asset = await assetRepo.findOne({ where: { id: assetId, questionId } });
  if (!asset) throw NotFound('Question asset');
  await asset.destroy();
  await audit({
    action: 'question.asset_removed',
    entityType: 'question',
    entityId: questionId,
    metadata: { assetId },
  });
  return getQuestion(questionId);
}

// ---------------------------------------------------------------- import

export function importTemplateCsv(): string {
  return toCsv([
    [...QUESTION_IMPORT_COLUMNS],
    [
      'single',
      'What is 2 + 2?',
      '3',
      '4',
      '5',
      '6',
      '',
      '',
      'B',
      '',
      'Basic addition',
      'easy',
      'arithmetic',
      '4',
      '1',
      '',
      '',
    ],
    [
      'multiple',
      'Which are prime?',
      '2',
      '3',
      '4',
      '9',
      '',
      '',
      'A,B',
      '',
      '',
      'medium',
      'primes',
      '4',
      '2',
      '',
      '',
    ],
    [
      'numerical',
      'Value of g (m/s²)?',
      '',
      '',
      '',
      '',
      '',
      '',
      '9.8',
      '0.1',
      '',
      'easy',
      '',
      '4',
      '0',
      '',
      '',
    ],
    [
      'true_false',
      'The sun is a star.',
      '',
      '',
      '',
      '',
      '',
      '',
      'TRUE',
      '',
      '',
      'easy',
      '',
      '1',
      '0',
      '',
      '',
    ],
    [
      'descriptive',
      "State Newton's first law.",
      '',
      '',
      '',
      '',
      '',
      '',
      'An object stays at rest or in uniform motion unless acted on by a net force.',
      '',
      '',
      'medium',
      'laws',
      '5',
      '0',
      '',
      '',
    ],
  ]);
}

const TYPE_ALIASES: Record<string, QuestionType> = {
  single: 'single',
  mcq: 'single',
  scq: 'single',
  multiple: 'multiple',
  mcq_multi: 'multiple',
  msq: 'multiple',
  numerical: 'numerical',
  numeric: 'numerical',
  integer: 'numerical',
  true_false: 'true_false',
  truefalse: 'true_false',
  tf: 'true_false',
  descriptive: 'descriptive',
  subjective: 'descriptive',
};

const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

/** Converts one import row (header → value) into a QuestionInput. Throws with a readable message. */
export function rowToQuestion(row: Record<string, string>): QuestionInput {
  const rawType = (row.type ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const type = TYPE_ALIASES[rawType];
  if (!type) throw new Error(`Unknown type "${row.type ?? ''}"`);
  const answer = (row.answer ?? '').trim();
  const options = ['a', 'b', 'c', 'd', 'e', 'f']
    .map((k) => ({ key: k.toUpperCase(), text: (row[`option_${k}`] ?? '').trim() }))
    .filter((o) => o.text);
  let answerKey: AnswerKey = {};
  if (type === 'single' || type === 'multiple')
    answerKey = {
      options: answer
        .split(/[,;|\s]+/)
        .filter(Boolean)
        .map((s) => s.toUpperCase()),
    };
  else if (type === 'true_false') {
    const v = answer.toLowerCase();
    if (!['true', 'false', 't', 'f', '1', '0', 'yes', 'no'].includes(v))
      throw new Error('Answer must be TRUE or FALSE');
    answerKey = { value: ['true', 't', '1', 'yes'].includes(v) };
  } else if (type === 'numerical') {
    const range = /^(-?[\d.]+)\s*(?:\.\.|to|:)\s*(-?[\d.]+)$/i.exec(answer);
    if (range) answerKey = { min: Number(range[1]), max: Number(range[2]) };
    else {
      const value = Number(answer);
      if (answer === '' || Number.isNaN(value))
        throw new Error('Numerical answer must be a number or a range like 1.5..2');
      answerKey = { value, tolerance: num(row.tolerance ?? '') ?? 0 };
    }
  } else if (answer) answerKey = { modelAnswer: answer };
  const difficulty = (row.difficulty ?? '').trim().toLowerCase();
  const candidate = {
    type,
    text: (row.text ?? '').trim(),
    options: type === 'single' || type === 'multiple' ? options : undefined,
    answerKey,
    explanation: (row.explanation ?? '').trim() || null,
    difficulty: difficulty || undefined,
    tags: (row.tags ?? '')
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter(Boolean),
    defaultMarks: num(row.marks ?? ''),
    defaultNegativeMarks: num(row.negative_marks ?? ''),
    source: 'import' as const,
  };
  const parsed = questionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue.path.join('.') || 'row'}: ${issue.message}`);
  }
  return parsed.data as QuestionInput;
}

export async function importQuestions(
  bankId: number,
  file: { buffer: Buffer; originalName: string; mimeType: string },
): Promise<QuestionImportResult> {
  const bank = await findEditableBank(bankId);
  const rows = parseSpreadsheet(file.buffer, file.originalName, file.mimeType);
  if (rows.length < 2) throw BadRequest('The file has no question rows (first row must be the header)');
  if (rows.length > 1001) throw BadRequest('Import at most 1000 questions per file');
  const header = rows[0].map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
  if (!header.includes('type') || !header.includes('text'))
    throw BadRequest(`Header must include: ${QUESTION_IMPORT_COLUMNS.join(', ')}`);

  // Chapters/topics are matched by name within the bank subject (or any subject when unset).
  const chapters = await chapterRepo.findAll({
    where: bank.subjectId ? { subjectId: bank.subjectId } : {},
    attributes: ['id', 'name', 'subjectId'],
  });
  const topics = chapters.length
    ? await topicRepo.findAll({
        where: { chapterId: chapters.map((c) => c.id) },
        attributes: ['id', 'name', 'chapterId'],
      })
    : [];
  const lc = (s: string) => s.trim().toLowerCase();

  const result: QuestionImportResult = { created: 0, failed: [] };
  for (let i = 1; i < rows.length; i++) {
    const record = Object.fromEntries(header.map((h, idx) => [h, rows[i][idx] ?? '']));
    try {
      const input = rowToQuestion(record);
      if (record.chapter?.trim()) {
        const ch = chapters.find((c) => lc(c.name) === lc(record.chapter));
        if (!ch) throw new Error(`Unknown chapter "${record.chapter}"`);
        input.chapterId = ch.id;
      }
      if (record.topic?.trim()) {
        const tp = topics.find(
          (t) => lc(t.name) === lc(record.topic) && (!input.chapterId || t.chapterId === input.chapterId),
        );
        if (!tp) throw new Error(`Unknown topic "${record.topic}"`);
        input.topicId = tp.id;
      }
      await questionRepo.create({
        bankId: bank.id,
        ...(await buildQuestionValues(input, bank)),
        source: 'import',
        createdByUserId: me(),
      });
      result.created++;
    } catch (err) {
      result.failed.push({ row: i + 1, message: (err as Error).message });
    }
  }
  await audit({
    action: 'question.imported',
    entityType: 'question_bank',
    entityId: bankId,
    metadata: { created: result.created, failed: result.failed.length, file: file.originalName },
  });
  return result;
}

export async function exportQuestionsCsv(bankId: number): Promise<string> {
  await findVisibleBank(bankId);
  const qs = await questionRepo.findAll({
    where: { bankId, status: { [Op.ne]: 'archived' } } as WhereOptions<Question>,
    include: [
      { model: Chapter, as: 'chapter', attributes: ['id', 'name'] },
      { model: Topic, as: 'topic', attributes: ['id', 'name'] },
    ],
    order: [['id', 'ASC']],
  });
  const rows = qs.map((q) => {
    const opts = Object.fromEntries((q.options ?? []).map((o) => [o.key, o.text]));
    const k = q.answerKey;
    const answer =
      q.type === 'single' || q.type === 'multiple'
        ? (k.options ?? []).join(',')
        : q.type === 'true_false'
          ? k.value
            ? 'TRUE'
            : 'FALSE'
          : q.type === 'numerical'
            ? typeof k.value === 'number'
              ? String(k.value)
              : `${k.min}..${k.max}`
            : (k.modelAnswer ?? '');
    return [
      q.type,
      q.text,
      opts.A ?? '',
      opts.B ?? '',
      opts.C ?? '',
      opts.D ?? '',
      opts.E ?? '',
      opts.F ?? '',
      answer,
      q.type === 'numerical' && typeof k.value === 'number' ? (k.tolerance ?? 0) : '',
      q.explanation ?? '',
      q.difficulty,
      (q.tags ?? []).join(','),
      q.defaultMarks,
      q.defaultNegativeMarks,
      q.chapter?.name ?? '',
      q.topic?.name ?? '',
    ];
  });
  return toCsv([[...QUESTION_IMPORT_COLUMNS], ...rows]);
}

// ---------------------------------------------------------------- AI draft generation

const GENERATE_SYSTEM = `You are an experienced teacher writing exam questions for a coaching institute.
Return ONLY a JSON object: {"questions": [ ... ]}. Each question object has:
- "type": one of "single" | "multiple" | "numerical" | "true_false" | "descriptive" (use the requested type)
- "text": the question stem (plain text; LaTeX allowed between $...$)
- "options": for single/multiple only, an array of {"key": "A".., "text": ...} with 4 options
- "answerKey": single/multiple → {"options": ["B"]}; true_false → {"value": true|false};
  numerical → {"value": number, "tolerance": number}; descriptive → {"modelAnswer": string, "rubric": string}
- "explanation": a short worked solution
- "difficulty": "easy" | "medium" | "hard"
- "tags": array of short keywords
Questions must be factually correct, unambiguous and distinct.`;

export async function generateDrafts(input: GenerateQuestionsInput): Promise<GeneratedQuestionsDto> {
  let topicLabel = input.topic ?? '';
  let acad: { subjectId?: number | null; chapterId?: number | null; topicId?: number | null } = {};
  if (input.topicId) {
    const topic = await topicRepo.findById(input.topicId);
    const chapter = await chapterRepo.findById(topic.chapterId);
    const subject = await subjectRepo.findById(chapter.subjectId);
    topicLabel = `${subject.name} › ${chapter.name} › ${topic.name}${input.topic ? ` (${input.topic})` : ''}`;
    acad = { subjectId: subject.id, chapterId: chapter.id, topicId: topic.id };
  }
  const user = [
    `Topic: ${topicLabel}`,
    `Question type: ${input.type}`,
    `Number of questions: ${input.count}`,
    `Difficulty: ${input.difficulty ?? 'mixed'}`,
    input.instructions ? `Additional instructions: ${input.instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const res = await aiChat({
    feature: 'question-bank.generate',
    jsonMode: true,
    temperature: 0.7,
    messages: [
      { role: 'system', content: GENERATE_SYSTEM },
      { role: 'user', content: user },
    ],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(res.content));
  } catch {
    throw new AppError(502, 'AI_BAD_OUTPUT', 'The AI response was not valid JSON');
  }
  const list = Array.isArray(parsed) ? parsed : ((parsed as { questions?: unknown[] })?.questions ?? []);
  const drafts: QuestionInput[] = [];
  for (const raw of list.slice(0, input.count)) {
    const r = raw as Record<string, unknown>;
    const check = questionSchema.safeParse({
      ...r,
      type: input.type,
      difficulty: r.difficulty ?? input.difficulty,
      source: 'ai',
      status: 'draft',
    });
    if (check.success) drafts.push({ ...(check.data as QuestionInput), ...acad });
  }
  await audit({
    action: 'question.ai_generated',
    entityType: 'question',
    metadata: { requested: input.count, returned: drafts.length, topic: topicLabel, model: res.model },
  });
  return { drafts, model: res.model };
}

/** Accepts plain JSON or JSON wrapped in a markdown fence. */
export function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const text = (fenced ? fenced[1] : content).trim();
  const start = text.search(/[[{]/);
  return start > 0 ? text.slice(start) : text;
}
