import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { MktQuizOptionDto, MktQuizQuestionKind } from '@erp/shared';

/** Quiz and certificate models (platform-wide, like the other marketplace models). */

type Attrs<M extends Model> = InferAttributes<M>;
type Create<M extends Model> = InferCreationAttributes<M>;

export class MktQuiz extends Model<Attrs<MktQuiz>, Create<MktQuiz>> {
  declare id: CreationOptional<number>;
  declare lectureId: number;
  declare passPercent: number;
  declare maxAttempts: number | null;
  declare shuffle: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktQuizQuestion extends Model<Attrs<MktQuizQuestion>, Create<MktQuizQuestion>> {
  declare id: CreationOptional<number>;
  declare lectureId: number;
  declare kind: MktQuizQuestionKind;
  declare prompt: string;
  declare options: MktQuizOptionDto[];
  declare correct: string[];
  declare explanation: string | null;
  declare sortOrder: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktQuizAttempt extends Model<Attrs<MktQuizAttempt>, Create<MktQuizAttempt>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare courseId: number;
  declare lectureId: number;
  declare answers: Record<string, string[]>;
  declare score: number;
  declare total: number;
  declare percent: number;
  declare passed: boolean;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktCertificate extends Model<Attrs<MktCertificate>, Create<MktCertificate>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare userId: number;
  declare courseId: number;
  declare learnerName: string;
  declare courseTitle: string;
  declare sellerName: string;
  declare issuedAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };
/** mysql2 may hand JSON columns back as strings. */
const json = (field: string) => ({
  type: DataTypes.JSON,
  allowNull: false,
  get(this: Model) {
    const v = this.getDataValue(field) as unknown;
    return typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  },
});

export function initQuizModels(sequelize: Sequelize) {
  MktQuiz.init(
    {
      id: pk,
      lectureId: uint(false),
      passPercent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
      maxAttempts: uint(),
      shuffle: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      ...stamps,
    },
    { sequelize, tableName: 'mkt_quizzes' },
  );
  MktQuizQuestion.init(
    {
      id: pk,
      lectureId: uint(false),
      kind: { type: DataTypes.STRING(10), allowNull: false },
      prompt: { type: DataTypes.TEXT, allowNull: false },
      options: json('options'),
      correct: json('correct'),
      explanation: { type: DataTypes.TEXT, allowNull: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...stamps,
    },
    { sequelize, tableName: 'mkt_quiz_questions' },
  );
  MktQuizAttempt.init(
    {
      id: pk,
      userId: uint(false),
      courseId: uint(false),
      lectureId: uint(false),
      answers: json('answers'),
      score: uint(false),
      total: uint(false),
      percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
      passed: { type: DataTypes.BOOLEAN, allowNull: false },
      ...stamps,
    },
    { sequelize, tableName: 'mkt_quiz_attempts' },
  );
  MktCertificate.init(
    {
      id: pk,
      code: { type: DataTypes.STRING(20), allowNull: false },
      userId: uint(false),
      courseId: uint(false),
      learnerName: { type: DataTypes.STRING(150), allowNull: false },
      courseTitle: { type: DataTypes.STRING(160), allowNull: false },
      sellerName: { type: DataTypes.STRING(150), allowNull: false },
      issuedAt: { type: DataTypes.DATE, allowNull: false },
      ...stamps,
    },
    { sequelize, tableName: 'mkt_certificates' },
  );
}
