import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { DoubtStatus } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { Batch, Subject } from '../academics/api';
import { LmsResource } from '../lms/api';
import { LiveSession } from '../live-classes/api';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

export class Doubt extends Model<InferAttributes<Doubt>, InferCreationAttributes<Doubt>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare studentUserId: number;
  declare teacherUserId: number | null;
  declare batchId: number | null;
  declare subjectId: number | null;
  declare lectureId: number | null;
  declare positionSeconds: number | null;
  declare liveClassId: number | null;
  declare question: string;
  declare fileId: number | null;
  declare status: CreationOptional<DoubtStatus>;
  declare replyCount: CreationOptional<number>;
  declare lastActivityAt: CreationOptional<Date>;
  declare answeredAt: CreationOptional<Date | null>;
  declare resolvedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare student?: NonAttribute<User | null>;
  declare teacher?: NonAttribute<User | null>;
  declare batch?: NonAttribute<Batch | null>;
  declare subject?: NonAttribute<Subject | null>;
  declare lecture?: NonAttribute<LmsResource | null>;
  declare liveClass?: NonAttribute<LiveSession | null>;

  static initModel(sequelize: Sequelize) {
    Doubt.init(
      {
        id: pk,
        instituteId: uint(false),
        branchId: uint(),
        studentUserId: uint(false),
        teacherUserId: uint(),
        batchId: uint(),
        subjectId: uint(),
        lectureId: uint(),
        positionSeconds: uint(),
        liveClassId: uint(),
        question: { type: DataTypes.TEXT, allowNull: false },
        fileId: uint(),
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'open' },
        replyCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastActivityAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        answeredAt: DataTypes.DATE,
        resolvedAt: DataTypes.DATE,
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'doubts' },
    );
    registerTenantModel(Doubt);
  }
}

export class DoubtReply extends Model<InferAttributes<DoubtReply>, InferCreationAttributes<DoubtReply>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare doubtId: number;
  declare authorUserId: number | null;
  declare fromTeacher: CreationOptional<boolean>;
  declare body: string | null;
  declare fileId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare author?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    DoubtReply.init(
      {
        id: pk,
        instituteId: uint(false),
        doubtId: uint(false),
        authorUserId: uint(),
        fromTeacher: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        body: DataTypes.TEXT,
        fileId: uint(),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'doubt_replies' },
    );
    registerTenantModel(DoubtReply);
  }
}

export function initDoubtModels(sequelize: Sequelize) {
  Doubt.initModel(sequelize);
  DoubtReply.initModel(sequelize);
}

export function associateDoubtModels() {
  Doubt.belongsTo(User, { as: 'student', foreignKey: 'studentUserId', constraints: false });
  Doubt.belongsTo(User, { as: 'teacher', foreignKey: 'teacherUserId', constraints: false });
  Doubt.belongsTo(Batch, { as: 'batch', foreignKey: 'batchId', constraints: false });
  Doubt.belongsTo(Subject, { as: 'subject', foreignKey: 'subjectId', constraints: false });
  Doubt.belongsTo(LmsResource, { as: 'lecture', foreignKey: 'lectureId', constraints: false });
  Doubt.belongsTo(LiveSession, { as: 'liveClass', foreignKey: 'liveClassId', constraints: false });
  DoubtReply.belongsTo(User, { as: 'author', foreignKey: 'authorUserId', constraints: false });
}

const USER_ATTRS = ['id', 'name'];

/** Includes for doubt DTOs. */
export const doubtIncludes = () => [
  { model: User, as: 'student', attributes: USER_ATTRS },
  { model: User, as: 'teacher', attributes: USER_ATTRS },
  { model: Batch, as: 'batch', attributes: ['id', 'name'] },
  { model: Subject, as: 'subject', attributes: ['id', 'name'] },
  { model: LmsResource, as: 'lecture', attributes: ['id', 'title'] },
  { model: LiveSession, as: 'liveClass', attributes: ['id', 'title'] },
];
export const authorInclude = () => ({ model: User, as: 'author', attributes: USER_ATTRS });
