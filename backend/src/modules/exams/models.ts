import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  AnswerKey,
  AnswerResponse,
  AttemptStatus,
  EvaluationMode,
  EvaluationStatus,
  ExamStatus,
  GradingJobStatus,
  QuestionOption,
  QuestionType,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';
import { Batch, Course } from '../academics/api';
import { Question, decimal } from '../question-bank/api';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const bool = (defaultValue = false) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const ts = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

/** Frozen copy of a bank question taken when it is added to an exam. */
export interface QuestionSnapshot {
  type: QuestionType;
  text: string;
  options: QuestionOption[];
  answerKey: AnswerKey;
  explanation: string | null;
  assetFileIds: number[];
  chapterId: number | null;
  chapterName: string | null;
  topicId: number | null;
  topicName: string | null;
}

export class PromptVersion extends Model<InferAttributes<PromptVersion>, InferCreationAttributes<PromptVersion>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare feature: string;
  declare version: number;
  declare name: string;
  declare systemPrompt: string;
  declare isActive: CreationOptional<boolean>;
  declare notes: string | null;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Exam extends Model<InferAttributes<Exam>, InferCreationAttributes<Exam>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare title: string;
  declare description: string | null;
  declare instructions: string | null;
  declare batchId: number | null;
  declare courseId: number | null;
  declare subjectId: number | null;
  declare startAt: Date;
  declare endAt: Date;
  declare durationMinutes: number;
  declare status: CreationOptional<ExamStatus>;
  declare evaluationMode: CreationOptional<EvaluationMode>;
  declare promptVersionId: number | null;
  declare shuffleQuestions: CreationOptional<boolean>;
  declare shuffleOptions: CreationOptional<boolean>;
  declare partialMarking: CreationOptional<boolean>;
  declare defaultMarks: CreationOptional<number>;
  declare defaultNegativeMarks: CreationOptional<number>;
  declare passMarks: number | null;
  declare resultsPublishedAt: Date | null;
  declare resultsPublishedBy: number | null;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare batch?: NonAttribute<Batch | null>;
  declare course?: NonAttribute<Course | null>;
  declare sections?: NonAttribute<ExamSection[]>;
  declare questions?: NonAttribute<ExamQuestion[]>;
}

export class ExamSection extends Model<InferAttributes<ExamSection>, InferCreationAttributes<ExamSection>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare examId: number;
  declare title: string;
  declare instructions: string | null;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ExamQuestion extends Model<InferAttributes<ExamQuestion>, InferCreationAttributes<ExamQuestion>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare examId: number;
  declare sectionId: number;
  declare questionId: number;
  declare sortOrder: CreationOptional<number>;
  declare marks: number;
  declare negativeMarks: number;
  declare partialMarking: CreationOptional<boolean>;
  declare snapshot: QuestionSnapshot;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare question?: NonAttribute<Question>;
}

export class ExamAttempt extends Model<InferAttributes<ExamAttempt>, InferCreationAttributes<ExamAttempt>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare examId: number;
  declare studentUserId: number;
  declare status: CreationOptional<AttemptStatus>;
  declare startedAt: Date;
  declare deadlineAt: Date;
  declare submittedAt: Date | null;
  declare lastSeenAt: Date | null;
  declare questionOrder: number[];
  declare optionOrders: Record<string, string[]> | null;
  declare objectiveScore: CreationOptional<number>;
  declare descriptiveScore: CreationOptional<number>;
  declare totalScore: CreationOptional<number>;
  declare maxScore: CreationOptional<number>;
  declare pendingEvaluations: CreationOptional<number>;
  declare rank: number | null;
  declare percentile: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare student?: NonAttribute<User>;
  declare exam?: NonAttribute<Exam>;
}

export class ExamAnswer extends Model<InferAttributes<ExamAnswer>, InferCreationAttributes<ExamAnswer>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare attemptId: number;
  declare examQuestionId: number;
  declare response: AnswerResponse | null;
  declare markedForReview: CreationOptional<boolean>;
  declare visited: CreationOptional<boolean>;
  declare timeSpentSeconds: CreationOptional<number>;
  declare autoScore: number | null;
  declare isCorrect: boolean | null;
  declare savedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare pages?: NonAttribute<ExamAnswerPage[]>;
  declare evaluation?: NonAttribute<ExamEvaluation | null>;
  declare attempt?: NonAttribute<ExamAttempt>;
  declare examQuestion?: NonAttribute<ExamQuestion>;
}

export class ExamAnswerPage extends Model<InferAttributes<ExamAnswerPage>, InferCreationAttributes<ExamAnswerPage>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare answerId: number;
  declare fileId: number;
  declare pageNo: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject>;
}

export class GradingJob extends Model<InferAttributes<GradingJob>, InferCreationAttributes<GradingJob>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare examId: number;
  declare status: CreationOptional<GradingJobStatus>;
  declare mode: EvaluationMode;
  declare promptVersionId: number | null;
  declare total: CreationOptional<number>;
  declare processed: CreationOptional<number>;
  declare failed: CreationOptional<number>;
  declare error: string | null;
  declare requestedByUserId: number | null;
  declare startedAt: Date | null;
  declare finishedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class GradingResult extends Model<InferAttributes<GradingResult>, InferCreationAttributes<GradingResult>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare gradingJobId: number;
  declare answerId: number;
  declare promptVersionId: number | null;
  declare status: 'success' | 'error';
  declare model: string | null;
  declare marks: number | null;
  declare feedback: string | null;
  declare confidence: number | null;
  declare rawOutput: string | null;
  declare totalTokens: CreationOptional<number>;
  declare usedVision: CreationOptional<boolean>;
  declare error: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ExamEvaluation extends Model<InferAttributes<ExamEvaluation>, InferCreationAttributes<ExamEvaluation>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare answerId: number;
  declare status: CreationOptional<EvaluationStatus>;
  declare aiResultId: number | null;
  declare aiMarks: number | null;
  declare aiFeedback: string | null;
  declare teacherMarks: number | null;
  declare teacherFeedback: string | null;
  declare evaluatedByUserId: number | null;
  declare evaluatedAt: Date | null;
  declare finalMarks: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare aiResult?: NonAttribute<GradingResult | null>;
  declare evaluator?: NonAttribute<User | null>;
}

export class ExamResultCorrection extends Model<
  InferAttributes<ExamResultCorrection>,
  InferCreationAttributes<ExamResultCorrection>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare attemptId: number;
  declare answerId: number;
  declare beforeMarks: number | null;
  declare afterMarks: number;
  declare reason: string;
  declare correctedByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare correctedBy?: NonAttribute<User | null>;
}

export function initExamModels(sequelize: Sequelize) {
  const opts = (tableName: string) => ({ sequelize, tableName });
  PromptVersion.init(
    {
      id: pk,
      instituteId: uint(false),
      feature: { type: DataTypes.STRING(80), allowNull: false },
      version: uint(false),
      name: { type: DataTypes.STRING(150), allowNull: false },
      systemPrompt: { type: DataTypes.TEXT, allowNull: false },
      isActive: bool(),
      notes: DataTypes.STRING(1000),
      createdByUserId: uint(),
      ...ts,
    },
    opts('prompt_versions'),
  );
  Exam.init(
    {
      id: pk,
      instituteId: uint(false),
      branchId: uint(),
      title: { type: DataTypes.STRING(200), allowNull: false },
      description: DataTypes.TEXT,
      instructions: DataTypes.TEXT,
      batchId: uint(),
      courseId: uint(),
      subjectId: uint(),
      startAt: { type: DataTypes.DATE, allowNull: false },
      endAt: { type: DataTypes.DATE, allowNull: false },
      durationMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'draft' },
      evaluationMode: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'manual' },
      promptVersionId: uint(),
      shuffleQuestions: bool(),
      shuffleOptions: bool(),
      partialMarking: bool(),
      defaultMarks: decimal('defaultMarks', false, 1),
      defaultNegativeMarks: decimal('defaultNegativeMarks', false, 0),
      passMarks: decimal('passMarks', true),
      resultsPublishedAt: DataTypes.DATE,
      resultsPublishedBy: uint(),
      createdByUserId: uint(),
      ...ts,
    },
    opts('exams'),
  );
  ExamSection.init(
    {
      id: pk,
      instituteId: uint(false),
      examId: uint(false),
      title: { type: DataTypes.STRING(150), allowNull: false },
      instructions: DataTypes.TEXT,
      sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      ...ts,
    },
    opts('exam_sections'),
  );
  ExamQuestion.init(
    {
      id: pk,
      instituteId: uint(false),
      examId: uint(false),
      sectionId: uint(false),
      questionId: uint(false),
      sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      marks: decimal('marks', false, 1),
      negativeMarks: decimal('negativeMarks', false, 0),
      partialMarking: bool(),
      snapshot: { type: DataTypes.JSON, allowNull: false },
      ...ts,
    },
    opts('exam_questions'),
  );
  ExamAttempt.init(
    {
      id: pk,
      instituteId: uint(false),
      branchId: uint(),
      examId: uint(false),
      studentUserId: uint(false),
      status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'in_progress' },
      startedAt: { type: DataTypes.DATE, allowNull: false },
      deadlineAt: { type: DataTypes.DATE, allowNull: false },
      submittedAt: DataTypes.DATE,
      lastSeenAt: DataTypes.DATE,
      questionOrder: { type: DataTypes.JSON, allowNull: false },
      optionOrders: DataTypes.JSON,
      objectiveScore: decimal('objectiveScore', false, 0),
      descriptiveScore: decimal('descriptiveScore', false, 0),
      totalScore: decimal('totalScore', false, 0),
      maxScore: decimal('maxScore', false, 0),
      pendingEvaluations: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      rank: uint(),
      percentile: { ...decimal('percentile', true), type: DataTypes.DECIMAL(5, 2) },
      ...ts,
    },
    opts('exam_attempts'),
  );
  ExamAnswer.init(
    {
      id: pk,
      instituteId: uint(false),
      attemptId: uint(false),
      examQuestionId: uint(false),
      response: DataTypes.JSON,
      markedForReview: bool(),
      visited: bool(),
      timeSpentSeconds: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      autoScore: decimal('autoScore', true),
      isCorrect: { type: DataTypes.BOOLEAN, allowNull: true },
      savedAt: DataTypes.DATE,
      ...ts,
    },
    opts('exam_answers'),
  );
  ExamAnswerPage.init(
    {
      id: pk,
      instituteId: uint(false),
      answerId: uint(false),
      fileId: uint(false),
      pageNo: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
      ...ts,
    },
    opts('exam_answer_pages'),
  );
  GradingJob.init(
    {
      id: pk,
      instituteId: uint(false),
      examId: uint(false),
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'queued' },
      mode: { type: DataTypes.STRING(12), allowNull: false },
      promptVersionId: uint(),
      total: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      processed: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      failed: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      error: DataTypes.STRING(1000),
      requestedByUserId: uint(),
      startedAt: DataTypes.DATE,
      finishedAt: DataTypes.DATE,
      ...ts,
    },
    opts('grading_jobs'),
  );
  GradingResult.init(
    {
      id: pk,
      instituteId: uint(false),
      gradingJobId: uint(false),
      answerId: uint(false),
      promptVersionId: uint(),
      status: { type: DataTypes.STRING(10), allowNull: false },
      model: DataTypes.STRING(150),
      marks: decimal('marks', true),
      feedback: DataTypes.TEXT,
      confidence: { ...decimal('confidence', true), type: DataTypes.DECIMAL(4, 3) },
      rawOutput: DataTypes.TEXT,
      totalTokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      usedVision: bool(),
      error: DataTypes.STRING(1000),
      ...ts,
    },
    opts('grading_results'),
  );
  ExamEvaluation.init(
    {
      id: pk,
      instituteId: uint(false),
      answerId: uint(false),
      status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'pending' },
      aiResultId: uint(),
      aiMarks: decimal('aiMarks', true),
      aiFeedback: DataTypes.TEXT,
      teacherMarks: decimal('teacherMarks', true),
      teacherFeedback: DataTypes.TEXT,
      evaluatedByUserId: uint(),
      evaluatedAt: DataTypes.DATE,
      finalMarks: decimal('finalMarks', true),
      ...ts,
    },
    opts('exam_evaluations'),
  );
  ExamResultCorrection.init(
    {
      id: pk,
      instituteId: uint(false),
      attemptId: uint(false),
      answerId: uint(false),
      beforeMarks: decimal('beforeMarks', true),
      afterMarks: decimal('afterMarks', false, 0),
      reason: { type: DataTypes.STRING(1000), allowNull: false },
      correctedByUserId: uint(),
      ...ts,
    },
    opts('exam_result_corrections'),
  );
  for (const m of [
    PromptVersion,
    Exam,
    ExamSection,
    ExamQuestion,
    ExamAttempt,
    ExamAnswer,
    ExamAnswerPage,
    GradingJob,
    GradingResult,
    ExamEvaluation,
    ExamResultCorrection,
  ])
    registerTenantModel(m as never);
}

export function associateExamModels() {
  Exam.belongsTo(Batch, { as: 'batch', foreignKey: 'batchId' });
  Exam.belongsTo(Course, { as: 'course', foreignKey: 'courseId' });
  Exam.hasMany(ExamSection, { as: 'sections', foreignKey: 'examId' });
  Exam.hasMany(ExamQuestion, { as: 'questions', foreignKey: 'examId' });
  ExamQuestion.belongsTo(Question, { as: 'question', foreignKey: 'questionId' });
  ExamAttempt.belongsTo(User, { as: 'student', foreignKey: 'studentUserId' });
  ExamAttempt.belongsTo(Exam, { as: 'exam', foreignKey: 'examId' });
  ExamAnswer.belongsTo(ExamAttempt, { as: 'attempt', foreignKey: 'attemptId' });
  ExamAnswer.belongsTo(ExamQuestion, { as: 'examQuestion', foreignKey: 'examQuestionId' });
  ExamAnswer.hasMany(ExamAnswerPage, { as: 'pages', foreignKey: 'answerId' });
  ExamAnswer.hasOne(ExamEvaluation, { as: 'evaluation', foreignKey: 'answerId' });
  ExamAnswerPage.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId' });
  ExamEvaluation.belongsTo(GradingResult, { as: 'aiResult', foreignKey: 'aiResultId' });
  ExamEvaluation.belongsTo(User, { as: 'evaluator', foreignKey: 'evaluatedByUserId' });
  ExamResultCorrection.belongsTo(User, { as: 'correctedBy', foreignKey: 'correctedByUserId' });
}
