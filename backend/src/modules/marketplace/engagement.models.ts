import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { MktReviewStatus } from '@erp/shared';
import { User } from '../users/user.model';
import { MktCourse, MktLecture } from './models';

/** Reviews, Q&A and wishlist (platform-wide like the other marketplace models). */

type Attrs<M extends Model> = InferAttributes<M>;
type Create<M extends Model> = InferCreationAttributes<M>;

export class MktReview extends Model<Attrs<MktReview>, Create<MktReview>> {
  declare id: CreationOptional<number>;
  declare courseId: number;
  declare userId: number;
  declare rating: number;
  declare title: string | null;
  declare body: string | null;
  declare status: CreationOptional<MktReviewStatus>;
  declare reportCount: CreationOptional<number>;
  declare hiddenReason: CreationOptional<string | null>;
  declare hiddenAt: CreationOptional<Date | null>;
  declare replyBody: CreationOptional<string | null>;
  declare replyByUserId: CreationOptional<number | null>;
  declare repliedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
  declare course?: NonAttribute<MktCourse>;
  declare reports?: NonAttribute<MktReviewReport[]>;
}

export class MktReviewReport extends Model<Attrs<MktReviewReport>, Create<MktReviewReport>> {
  declare id: CreationOptional<number>;
  declare reviewId: number;
  declare userId: number;
  declare reason: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktQuestion extends Model<Attrs<MktQuestion>, Create<MktQuestion>> {
  declare id: CreationOptional<number>;
  declare courseId: number;
  declare lectureId: number | null;
  declare userId: number;
  declare title: string;
  declare body: string | null;
  declare answered: CreationOptional<boolean>;
  declare answerCount: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
  declare lecture?: NonAttribute<MktLecture | null>;
  declare course?: NonAttribute<MktCourse>;
  declare answers?: NonAttribute<MktAnswer[]>;
}

export class MktAnswer extends Model<Attrs<MktAnswer>, Create<MktAnswer>> {
  declare id: CreationOptional<number>;
  declare questionId: number;
  declare userId: number;
  declare body: string;
  declare isInstructor: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

export class MktWishlistItem extends Model<Attrs<MktWishlistItem>, Create<MktWishlistItem>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare courseId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare course?: NonAttribute<MktCourse>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const text = (allowNull = true) => ({ type: DataTypes.TEXT, allowNull });
const count = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const date = () => ({ type: DataTypes.DATE, allowNull: true });
const bool = () => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export function initEngagementModels(sequelize: Sequelize) {
  MktReview.init(
    {
      id: pk,
      courseId: uint(false),
      userId: uint(false),
      rating: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
      title: str(150, true),
      body: text(),
      status: { ...str(20), defaultValue: 'visible' },
      reportCount: count(),
      hiddenReason: str(500, true),
      hiddenAt: date(),
      replyBody: text(),
      replyByUserId: uint(),
      repliedAt: date(),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_reviews' },
  );
  MktReviewReport.init(
    { id: pk, reviewId: uint(false), userId: uint(false), reason: str(500), ...stamps },
    { sequelize, tableName: 'mkt_review_reports' },
  );
  MktQuestion.init(
    {
      id: pk,
      courseId: uint(false),
      lectureId: uint(),
      userId: uint(false),
      title: str(200),
      body: text(),
      answered: bool(),
      answerCount: count(),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_questions' },
  );
  MktAnswer.init(
    {
      id: pk,
      questionId: uint(false),
      userId: uint(false),
      body: text(false),
      isInstructor: bool(),
      ...stamps,
    },
    { sequelize, tableName: 'mkt_answers' },
  );
  MktWishlistItem.init(
    { id: pk, userId: uint(false), courseId: uint(false), ...stamps },
    { sequelize, tableName: 'mkt_wishlist_items' },
  );
}

export function associateEngagementModels() {
  MktReview.belongsTo(User, { as: 'user', foreignKey: 'userId', constraints: false });
  MktReview.belongsTo(MktCourse, { as: 'course', foreignKey: 'courseId', constraints: false });
  MktReview.hasMany(MktReviewReport, { as: 'reports', foreignKey: 'reviewId', constraints: false });
  MktQuestion.belongsTo(User, { as: 'user', foreignKey: 'userId', constraints: false });
  MktQuestion.belongsTo(MktLecture, { as: 'lecture', foreignKey: 'lectureId', constraints: false });
  MktQuestion.belongsTo(MktCourse, { as: 'course', foreignKey: 'courseId', constraints: false });
  MktQuestion.hasMany(MktAnswer, { as: 'answers', foreignKey: 'questionId', constraints: false });
  MktAnswer.belongsTo(User, { as: 'user', foreignKey: 'userId', constraints: false });
  MktWishlistItem.belongsTo(MktCourse, { as: 'course', foreignKey: 'courseId', constraints: false });
}
