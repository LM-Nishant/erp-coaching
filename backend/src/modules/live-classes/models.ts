import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type InitOptions,
  type ModelAttributes,
  type ModelStatic,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { LiveRole, LiveSessionStatus } from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';
import { Batch } from '../academics/api';

export class LiveSession extends Model<InferAttributes<LiveSession>, InferCreationAttributes<LiveSession>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare batchId: number;
  declare courseId: number | null;
  declare subjectId: number | null;
  declare classSessionId: number | null;
  declare teacherUserId: number;
  declare title: string;
  declare description: string | null;
  declare scheduledStartAt: Date;
  declare scheduledEndAt: Date;
  declare status: CreationOptional<LiveSessionStatus>;
  declare startedAt: CreationOptional<Date | null>;
  declare endedAt: CreationOptional<Date | null>;
  declare recordingEnabled: CreationOptional<boolean>;
  declare provider: string;
  declare roomId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare teacher?: NonAttribute<User>;
  declare batch?: NonAttribute<Batch>;
}

export class LiveParticipant extends Model<
  InferAttributes<LiveParticipant>,
  InferCreationAttributes<LiveParticipant>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare liveSessionId: number;
  declare userId: number;
  declare role: LiveRole;
  declare firstJoinedAt: Date | null;
  declare lastJoinedAt: Date | null;
  declare lastLeftAt: Date | null;
  declare totalSeconds: CreationOptional<number>;
  declare joinCount: CreationOptional<number>;
  declare isOnline: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

export class LiveChatMessage extends Model<
  InferAttributes<LiveChatMessage>,
  InferCreationAttributes<LiveChatMessage>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare liveSessionId: number;
  declare userId: number;
  declare kind: 'chat' | 'question';
  declare body: string;
  declare upvotes: CreationOptional<number>;
  declare isAnswered: CreationOptional<boolean>;
  declare answeredAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

export class LiveQuestionVote extends Model<
  InferAttributes<LiveQuestionVote>,
  InferCreationAttributes<LiveQuestionVote>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare messageId: number;
  declare userId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class LivePoll extends Model<InferAttributes<LivePoll>, InferCreationAttributes<LivePoll>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare liveSessionId: number;
  declare createdByUserId: number;
  declare question: string;
  declare options: string[];
  declare status: CreationOptional<'open' | 'closed'>;
  declare closedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class LivePollResponse extends Model<
  InferAttributes<LivePollResponse>,
  InferCreationAttributes<LivePollResponse>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare pollId: number;
  declare userId: number;
  declare optionIndex: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class LiveRecording extends Model<
  InferAttributes<LiveRecording>,
  InferCreationAttributes<LiveRecording>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare liveSessionId: number;
  declare batchId: number;
  declare courseId: number | null;
  declare fileId: number;
  declare title: string;
  declare durationSeconds: number | null;
  declare source: 'provider' | 'client-upload';
  declare providerRef: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const date = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const base = { id: pk, instituteId: uint(false), createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

function define<M extends Model>(
  model: ModelStatic<M>,
  sequelize: Sequelize,
  tableName: string,
  attrs: Record<string, unknown>,
) {
  (model as unknown as { init: (a: ModelAttributes, o: InitOptions) => void }).init(
    { ...base, ...attrs } as ModelAttributes,
    { sequelize, tableName },
  );
  registerTenantModel(model);
}

export function initLiveModels(sequelize: Sequelize) {
  define(LiveSession, sequelize, 'live_sessions', {
    branchId: uint(false),
    batchId: uint(false),
    courseId: uint(),
    subjectId: uint(),
    classSessionId: uint(),
    teacherUserId: uint(false),
    title: str(200),
    description: { type: DataTypes.TEXT, allowNull: true },
    scheduledStartAt: date(false),
    scheduledEndAt: date(false),
    status: { ...str(20), defaultValue: 'scheduled' },
    startedAt: date(),
    endedAt: date(),
    recordingEnabled: bool(true),
    provider: str(30),
    roomId: str(120, true),
  });
  define(LiveParticipant, sequelize, 'live_participants', {
    liveSessionId: uint(false),
    userId: uint(false),
    role: str(20),
    firstJoinedAt: date(),
    lastJoinedAt: date(),
    lastLeftAt: date(),
    totalSeconds: { ...uint(false), defaultValue: 0 },
    joinCount: { ...uint(false), defaultValue: 0 },
    isOnline: bool(false),
  });
  define(LiveChatMessage, sequelize, 'live_chat_messages', {
    liveSessionId: uint(false),
    userId: uint(false),
    kind: { ...str(10), defaultValue: 'chat' },
    body: str(1000),
    upvotes: { ...uint(false), defaultValue: 0 },
    isAnswered: bool(false),
    answeredAt: date(),
  });
  define(LiveQuestionVote, sequelize, 'live_question_votes', {
    messageId: uint(false),
    userId: uint(false),
  });
  define(LivePoll, sequelize, 'live_polls', {
    liveSessionId: uint(false),
    createdByUserId: uint(false),
    question: str(300),
    options: { type: DataTypes.JSON, allowNull: false },
    status: { ...str(10), defaultValue: 'open' },
    closedAt: date(),
  });
  define(LivePollResponse, sequelize, 'live_poll_responses', {
    pollId: uint(false),
    userId: uint(false),
    optionIndex: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
  });
  define(LiveRecording, sequelize, 'live_recordings', {
    branchId: uint(false),
    liveSessionId: uint(false),
    batchId: uint(false),
    courseId: uint(),
    fileId: uint(false),
    title: str(200),
    durationSeconds: uint(),
    source: str(20),
    providerRef: str(191, true),
  });
}

export function associateLiveModels() {
  LiveSession.belongsTo(User, { as: 'teacher', foreignKey: 'teacherUserId' });
  LiveSession.belongsTo(Batch, { as: 'batch', foreignKey: 'batchId' });
  LiveParticipant.belongsTo(User, { as: 'user', foreignKey: 'userId' });
  LiveChatMessage.belongsTo(User, { as: 'user', foreignKey: 'userId' });
  LiveRecording.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId' });
}
