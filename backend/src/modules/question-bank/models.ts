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
  BankVisibility,
  QuestionDifficulty,
  QuestionImportStatus,
  QuestionOption,
  QuestionSource,
  QuestionStatus,
  QuestionType,
} from '@erp/shared';
import type { StoredDraft as StoredImportDraft } from './pdf-import.extract';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { FileObject } from '../files/file.model';
import { User } from '../users/user.model';
import { Chapter, Subject, Topic } from '../academics/api';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

/** DECIMAL columns come back from mysql2 as strings; expose them as numbers. */
export function decimal(name: string, allowNull = false, defaultValue?: number) {
  return {
    type: DataTypes.DECIMAL(8, 2),
    allowNull,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    get(this: Model) {
      const v = this.getDataValue(name);
      return v == null ? null : Number(v);
    },
  };
}

export class QuestionBank extends Model<
  InferAttributes<QuestionBank>,
  InferCreationAttributes<QuestionBank>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare name: string;
  declare description: string | null;
  declare subjectId: number | null;
  declare visibility: CreationOptional<BankVisibility>;
  declare ownerUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare owner?: NonAttribute<User | null>;
  declare subject?: NonAttribute<Subject | null>;

  static initModel(sequelize: Sequelize) {
    QuestionBank.init(
      {
        id: pk,
        instituteId: uint(false),
        branchId: uint(),
        name: { type: DataTypes.STRING(150), allowNull: false },
        description: DataTypes.STRING(1000),
        subjectId: uint(),
        visibility: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'shared' },
        ownerUserId: uint(),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'question_banks' },
    );
    registerTenantModel(QuestionBank);
  }
}

export class Question extends Model<InferAttributes<Question>, InferCreationAttributes<Question>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare bankId: number;
  declare type: QuestionType;
  declare text: string;
  declare options: QuestionOption[] | null;
  declare answerKey: AnswerKey;
  declare explanation: string | null;
  declare difficulty: CreationOptional<QuestionDifficulty>;
  declare tags: string[] | null;
  declare subjectId: number | null;
  declare chapterId: number | null;
  declare topicId: number | null;
  declare defaultMarks: CreationOptional<number>;
  declare defaultNegativeMarks: CreationOptional<number>;
  declare status: CreationOptional<QuestionStatus>;
  declare source: CreationOptional<QuestionSource>;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare bank?: NonAttribute<QuestionBank>;
  declare chapter?: NonAttribute<Chapter | null>;
  declare topic?: NonAttribute<Topic | null>;
  declare assets?: NonAttribute<QuestionAsset[]>;

  static initModel(sequelize: Sequelize) {
    Question.init(
      {
        id: pk,
        instituteId: uint(false),
        bankId: uint(false),
        type: { type: DataTypes.STRING(15), allowNull: false },
        text: { type: DataTypes.TEXT, allowNull: false },
        options: DataTypes.JSON,
        answerKey: { type: DataTypes.JSON, allowNull: false },
        explanation: DataTypes.TEXT,
        difficulty: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'medium' },
        tags: DataTypes.JSON,
        subjectId: uint(),
        chapterId: uint(),
        topicId: uint(),
        defaultMarks: decimal('defaultMarks', false, 1),
        defaultNegativeMarks: decimal('defaultNegativeMarks', false, 0),
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
        source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' },
        createdByUserId: uint(),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'questions' },
    );
    registerTenantModel(Question);
  }
}

export class QuestionAsset extends Model<
  InferAttributes<QuestionAsset>,
  InferCreationAttributes<QuestionAsset>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare questionId: number;
  declare fileId: number;
  declare role: CreationOptional<'question' | 'explanation'>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject>;

  static initModel(sequelize: Sequelize) {
    QuestionAsset.init(
      {
        id: pk,
        instituteId: uint(false),
        questionId: uint(false),
        fileId: uint(false),
        role: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'question' },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'question_assets' },
    );
    registerTenantModel(QuestionAsset);
  }
}

/** A question paper PDF being turned into reviewable drafts (see pdf-import.service). */
export class QuestionImport extends Model<
  InferAttributes<QuestionImport>,
  InferCreationAttributes<QuestionImport>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare bankId: number;
  declare createdByUserId: number | null;
  declare status: CreationOptional<QuestionImportStatus>;
  declare fileId: number | null;
  declare answerKeyFileId: number | null;
  declare fileName: string;
  declare answerKeyFileName: string | null;
  declare pageCount: CreationOptional<number>;
  declare pagesDone: CreationOptional<number>;
  declare drafts: CreationOptional<StoredImportDraft[] | null>;
  declare warnings: CreationOptional<string[] | null>;
  declare error: CreationOptional<string | null>;
  declare model: CreationOptional<string | null>;
  declare visionPages: CreationOptional<number>;
  declare totalTokens: CreationOptional<number>;
  declare savedCount: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    QuestionImport.init(
      {
        id: pk,
        instituteId: uint(false),
        branchId: uint(),
        bankId: uint(false),
        createdByUserId: uint(),
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'queued' },
        fileId: uint(),
        answerKeyFileId: uint(),
        fileName: { type: DataTypes.STRING(255), allowNull: false },
        answerKeyFileName: { type: DataTypes.STRING(255), allowNull: true },
        pageCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        pagesDone: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        drafts: { type: DataTypes.JSON, allowNull: true },
        warnings: { type: DataTypes.JSON, allowNull: true },
        error: { type: DataTypes.STRING(500), allowNull: true },
        model: { type: DataTypes.STRING(100), allowNull: true },
        visionPages: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        totalTokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        savedCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'question_imports' },
    );
    registerTenantModel(QuestionImport);
  }
}

export function initQuestionBankModels(sequelize: Sequelize) {
  QuestionBank.initModel(sequelize);
  Question.initModel(sequelize);
  QuestionAsset.initModel(sequelize);
  QuestionImport.initModel(sequelize);
}

export function associateQuestionBankModels() {
  QuestionBank.belongsTo(User, { as: 'owner', foreignKey: 'ownerUserId' });
  QuestionBank.belongsTo(Subject, { as: 'subject', foreignKey: 'subjectId' });
  QuestionBank.hasMany(Question, { as: 'questions', foreignKey: 'bankId' });
  Question.belongsTo(QuestionBank, { as: 'bank', foreignKey: 'bankId' });
  Question.belongsTo(Chapter, { as: 'chapter', foreignKey: 'chapterId' });
  Question.belongsTo(Topic, { as: 'topic', foreignKey: 'topicId' });
  Question.hasMany(QuestionAsset, { as: 'assets', foreignKey: 'questionId' });
  QuestionAsset.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId' });
}
