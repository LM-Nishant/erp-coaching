import {
  DataTypes,
  type InitOptions,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type ModelAttributes,
  type ModelStatic,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  LmsAccessType,
  LmsAssignmentStatus,
  LmsResourceStatus,
  LmsResourceType,
  LmsSubmissionStatus,
  LmsTranscodeStatus,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { FileObject } from '../files/file.model';
import { User } from '../users/user.model';
import { Batch, Course, Subject } from '../academics/api';

export class LmsResource extends Model<InferAttributes<LmsResource>, InferCreationAttributes<LmsResource>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare courseId: number;
  declare subjectId: number | null;
  declare chapterId: number | null;
  declare topicId: number | null;
  declare title: string;
  declare description: string | null;
  declare type: LmsResourceType;
  declare status: CreationOptional<LmsResourceStatus>;
  declare fileId: number | null;
  declare externalUrl: string | null;
  declare durationSeconds: number | null;
  declare access: CreationOptional<LmsAccessType>;
  declare accessDays: number | null;
  declare availableFrom: Date | null;
  declare availableUntil: Date | null;
  declare downloadable: CreationOptional<boolean>;
  declare offlineAllowed: CreationOptional<boolean>;
  declare offlineExpiryHours: CreationOptional<number>;
  declare sortOrder: CreationOptional<number>;
  declare transcodeStatus: CreationOptional<LmsTranscodeStatus>;
  declare transcodeError: CreationOptional<string | null>;
  declare hlsPrefix: CreationOptional<string | null>;
  /** Origin of system-created content (e.g. `live-recording:<id>`); unique per institute. */
  declare sourceRef: CreationOptional<string | null>;
  declare createdByUserId: number | null;
  declare publishedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject | null>;
  declare course?: NonAttribute<Course>;
  declare batchLinks?: NonAttribute<LmsResourceBatch[]>;
}

export class LmsResourceBatch extends Model<
  InferAttributes<LmsResourceBatch>,
  InferCreationAttributes<LmsResourceBatch>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare resourceId: number;
  declare batchId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class LmsProgress extends Model<InferAttributes<LmsProgress>, InferCreationAttributes<LmsProgress>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare resourceId: number;
  declare studentUserId: number;
  declare positionSeconds: CreationOptional<number>;
  declare durationSeconds: number | null;
  declare watchedSeconds: CreationOptional<number>;
  declare percent: CreationOptional<number>;
  declare completedAt: CreationOptional<Date | null>;
  declare lastViewedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare student?: NonAttribute<User>;
}

export class LmsAccessGrant extends Model<
  InferAttributes<LmsAccessGrant>,
  InferCreationAttributes<LmsAccessGrant>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentUserId: number;
  declare courseId: number;
  declare validFrom: Date;
  declare validUntil: Date | null;
  declare source: CreationOptional<string>;
  declare note: string | null;
  declare grantedByUserId: number | null;
  declare revokedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare student?: NonAttribute<User>;
  declare course?: NonAttribute<Course>;
}

export class LmsUploadSession extends Model<
  InferAttributes<LmsUploadSession>,
  InferCreationAttributes<LmsUploadSession>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare uploadId: string;
  declare userId: number;
  declare fileName: string;
  declare mimeType: string;
  declare totalBytes: number;
  declare receivedBytes: CreationOptional<number>;
  declare status: CreationOptional<'uploading' | 'completed' | 'aborted'>;
  declare fileId: CreationOptional<number | null>;
  declare expiresAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject | null>;
}

export class LmsOfflineLicense extends Model<
  InferAttributes<LmsOfflineLicense>,
  InferCreationAttributes<LmsOfflineLicense>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare resourceId: number;
  declare userId: number;
  declare deviceId: number;
  declare contentKey: string;
  declare expiresAt: Date;
  declare revokedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare resource?: NonAttribute<LmsResource>;
}

export class LmsAssignment extends Model<
  InferAttributes<LmsAssignment>,
  InferCreationAttributes<LmsAssignment>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare batchId: number;
  declare subjectId: number | null;
  declare chapterId: number | null;
  declare topicId: number | null;
  declare title: string;
  declare instructions: string | null;
  declare dueAt: Date;
  declare maxMarks: number | null;
  declare allowLate: CreationOptional<boolean>;
  declare status: CreationOptional<LmsAssignmentStatus>;
  declare publishedAt: CreationOptional<Date | null>;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare batch?: NonAttribute<Batch>;
  declare subject?: NonAttribute<Subject | null>;
  declare creator?: NonAttribute<User | null>;
  declare files?: NonAttribute<LmsAssignmentFile[]>;
}

export class LmsAssignmentFile extends Model<
  InferAttributes<LmsAssignmentFile>,
  InferCreationAttributes<LmsAssignmentFile>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare assignmentId: number;
  declare fileId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject>;
}

export class LmsSubmission extends Model<
  InferAttributes<LmsSubmission>,
  InferCreationAttributes<LmsSubmission>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare assignmentId: number;
  declare studentUserId: number;
  declare text: string | null;
  declare status: CreationOptional<LmsSubmissionStatus>;
  declare isLate: CreationOptional<boolean>;
  declare submittedAt: Date;
  declare marks: CreationOptional<number | null>;
  declare feedback: CreationOptional<string | null>;
  declare gradedByUserId: CreationOptional<number | null>;
  declare gradedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare student?: NonAttribute<User>;
  declare grader?: NonAttribute<User | null>;
  declare files?: NonAttribute<LmsSubmissionFile[]>;
}

export class LmsSubmissionFile extends Model<
  InferAttributes<LmsSubmissionFile>,
  InferCreationAttributes<LmsSubmissionFile>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare submissionId: number;
  declare fileId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const date = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });
/** DECIMAL comes back from mysql2 as a string; the API speaks numbers. */
const decimal = (field: string) => ({
  type: DataTypes.DECIMAL(7, 2),
  allowNull: true,
  get(this: Model) {
    const v = this.getDataValue(field) as string | number | null;
    return v === null || v === undefined ? null : Number(v);
  },
});
const bigint = (field: string, defaultValue?: number) => ({
  type: DataTypes.BIGINT.UNSIGNED,
  allowNull: false,
  ...(defaultValue !== undefined ? { defaultValue } : {}),
  get(this: Model) {
    return Number(this.getDataValue(field));
  },
});

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

export function initLmsModels(sequelize: Sequelize) {
  define(LmsResource, sequelize, 'lms_resources', {
    branchId: uint(),
    courseId: uint(false),
    subjectId: uint(),
    chapterId: uint(),
    topicId: uint(),
    title: str(200),
    description: { type: DataTypes.TEXT, allowNull: true },
    type: str(20),
    status: { ...str(20), defaultValue: 'draft' },
    fileId: uint(),
    externalUrl: str(1000, true),
    durationSeconds: uint(),
    access: { ...str(10), defaultValue: 'paid' },
    accessDays: uint(),
    availableFrom: date(),
    availableUntil: date(),
    downloadable: bool(false),
    offlineAllowed: bool(false),
    offlineExpiryHours: { ...uint(false), defaultValue: 72 },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    transcodeStatus: { ...str(20), defaultValue: 'none' },
    transcodeError: str(500, true),
    hlsPrefix: str(300, true),
    sourceRef: str(100, true),
    createdByUserId: uint(),
    publishedAt: date(),
  });
  define(LmsResourceBatch, sequelize, 'lms_resource_batches', {
    resourceId: uint(false),
    batchId: uint(false),
  });
  define(LmsProgress, sequelize, 'lms_progress', {
    resourceId: uint(false),
    studentUserId: uint(false),
    positionSeconds: { ...uint(false), defaultValue: 0 },
    durationSeconds: uint(),
    watchedSeconds: { ...uint(false), defaultValue: 0 },
    percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    completedAt: date(),
    lastViewedAt: date(),
  });
  define(LmsAccessGrant, sequelize, 'lms_access_grants', {
    studentUserId: uint(false),
    courseId: uint(false),
    validFrom: date(false),
    validUntil: date(),
    source: { ...str(30), defaultValue: 'manual' },
    note: str(500, true),
    grantedByUserId: uint(),
    revokedAt: date(),
  });
  define(LmsUploadSession, sequelize, 'lms_upload_sessions', {
    branchId: uint(),
    uploadId: str(36),
    userId: uint(false),
    fileName: str(255),
    mimeType: str(150),
    totalBytes: bigint('totalBytes'),
    receivedBytes: bigint('receivedBytes', 0),
    status: { ...str(20), defaultValue: 'uploading' },
    fileId: uint(),
    expiresAt: date(false),
  });
  define(LmsOfflineLicense, sequelize, 'lms_offline_licenses', {
    resourceId: uint(false),
    userId: uint(false),
    deviceId: uint(false),
    contentKey: str(200),
    expiresAt: date(false),
    revokedAt: date(),
  });
  define(LmsAssignment, sequelize, 'lms_assignments', {
    branchId: uint(false),
    batchId: uint(false),
    subjectId: uint(),
    chapterId: uint(),
    topicId: uint(),
    title: str(200),
    instructions: { type: DataTypes.TEXT, allowNull: true },
    dueAt: date(false),
    maxMarks: decimal('maxMarks'),
    allowLate: bool(true),
    status: { ...str(20), defaultValue: 'draft' },
    publishedAt: date(),
    createdByUserId: uint(),
  });
  define(LmsAssignmentFile, sequelize, 'lms_assignment_files', {
    assignmentId: uint(false),
    fileId: uint(false),
  });
  define(LmsSubmission, sequelize, 'lms_submissions', {
    assignmentId: uint(false),
    studentUserId: uint(false),
    text: { type: DataTypes.TEXT, allowNull: true },
    status: { ...str(20), defaultValue: 'submitted' },
    isLate: bool(false),
    submittedAt: date(false),
    marks: decimal('marks'),
    feedback: { type: DataTypes.TEXT, allowNull: true },
    gradedByUserId: uint(),
    gradedAt: date(),
  });
  define(LmsSubmissionFile, sequelize, 'lms_submission_files', {
    submissionId: uint(false),
    fileId: uint(false),
  });
}

export function associateLmsModels() {
  LmsResource.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId', constraints: false });
  LmsResource.belongsTo(Course, { as: 'course', foreignKey: 'courseId', constraints: false });
  LmsResource.hasMany(LmsResourceBatch, { as: 'batchLinks', foreignKey: 'resourceId', constraints: false });
  LmsProgress.belongsTo(User, { as: 'student', foreignKey: 'studentUserId', constraints: false });
  LmsAccessGrant.belongsTo(User, { as: 'student', foreignKey: 'studentUserId', constraints: false });
  LmsAccessGrant.belongsTo(Course, { as: 'course', foreignKey: 'courseId', constraints: false });
  LmsUploadSession.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId', constraints: false });
  LmsOfflineLicense.belongsTo(LmsResource, { as: 'resource', foreignKey: 'resourceId', constraints: false });
  LmsAssignment.belongsTo(Batch, { as: 'batch', foreignKey: 'batchId', constraints: false });
  LmsAssignment.belongsTo(Subject, { as: 'subject', foreignKey: 'subjectId', constraints: false });
  LmsAssignment.belongsTo(User, { as: 'creator', foreignKey: 'createdByUserId', constraints: false });
  LmsAssignment.hasMany(LmsAssignmentFile, { as: 'files', foreignKey: 'assignmentId', constraints: false });
  LmsAssignmentFile.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId', constraints: false });
  LmsSubmission.belongsTo(User, { as: 'student', foreignKey: 'studentUserId', constraints: false });
  LmsSubmission.belongsTo(User, { as: 'grader', foreignKey: 'gradedByUserId', constraints: false });
  LmsSubmission.hasMany(LmsSubmissionFile, { as: 'files', foreignKey: 'submissionId', constraints: false });
  LmsSubmissionFile.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId', constraints: false });
}
