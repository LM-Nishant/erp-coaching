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
  AcademicSessionStatus,
  BatchStatus,
  ClassNoteKind,
  ClassSessionStatus,
  CourseMode,
  DurationUnit,
  EnrollmentStatus,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';

export class AcademicSession extends Model<
  InferAttributes<AcademicSession>,
  InferCreationAttributes<AcademicSession>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare name: string;
  declare startDate: string;
  declare endDate: string;
  declare isCurrent: CreationOptional<boolean>;
  declare status: CreationOptional<AcademicSessionStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class CourseCategory extends Model<
  InferAttributes<CourseCategory>,
  InferCreationAttributes<CourseCategory>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare name: string;
  declare description: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Course extends Model<InferAttributes<Course>, InferCreationAttributes<Course>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare categoryId: number | null;
  declare templateId: number | null;
  declare name: string;
  declare code: string;
  declare description: string | null;
  declare mode: CreationOptional<CourseMode>;
  declare durationValue: number | null;
  declare durationUnit: DurationUnit | null;
  declare isTemplate: CreationOptional<boolean>;
  declare status: CreationOptional<'active' | 'archived'>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare branchLinks?: NonAttribute<CourseBranch[]>;
  declare subjectLinks?: NonAttribute<CourseSubject[]>;
}

export class CourseBranch extends Model<
  InferAttributes<CourseBranch>,
  InferCreationAttributes<CourseBranch>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare courseId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Subject extends Model<InferAttributes<Subject>, InferCreationAttributes<Subject>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare name: string;
  declare code: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class CourseSubject extends Model<
  InferAttributes<CourseSubject>,
  InferCreationAttributes<CourseSubject>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare courseId: number;
  declare subjectId: number;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Chapter extends Model<InferAttributes<Chapter>, InferCreationAttributes<Chapter>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare subjectId: number;
  declare name: string;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Topic extends Model<InferAttributes<Topic>, InferCreationAttributes<Topic>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare chapterId: number;
  declare name: string;
  declare sortOrder: CreationOptional<number>;
  declare durationMinutes: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Batch extends Model<InferAttributes<Batch>, InferCreationAttributes<Batch>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare courseId: number;
  declare academicSessionId: number;
  declare name: string;
  declare code: string;
  declare capacity: number;
  declare startDate: string;
  declare endDate: string | null;
  declare mode: CreationOptional<CourseMode>;
  declare status: CreationOptional<BatchStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare teachers?: NonAttribute<BatchTeacher[]>;
}

export class BatchTeacher extends Model<
  InferAttributes<BatchTeacher>,
  InferCreationAttributes<BatchTeacher>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare batchId: number;
  declare subjectId: number | null;
  declare teacherUserId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare teacher?: NonAttribute<User>;
}

export class BatchStudent extends Model<
  InferAttributes<BatchStudent>,
  InferCreationAttributes<BatchStudent>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare batchId: number;
  declare studentUserId: number;
  declare status: CreationOptional<EnrollmentStatus>;
  declare joinedOn: string;
  declare leftOn: string | null;
  declare promotedFromId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare student?: NonAttribute<User>;
  declare batch?: NonAttribute<Batch>;
}

export class StudentPromotion extends Model<
  InferAttributes<StudentPromotion>,
  InferCreationAttributes<StudentPromotion>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare studentUserId: number;
  declare fromBatchId: number;
  declare toBatchId: number;
  declare fromSessionId: number;
  declare toSessionId: number;
  declare promotedByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Classroom extends Model<InferAttributes<Classroom>, InferCreationAttributes<Classroom>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare name: string;
  declare capacity: number;
  declare isVirtual: CreationOptional<boolean>;
  declare status: CreationOptional<'active' | 'inactive'>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ClassSchedule extends Model<
  InferAttributes<ClassSchedule>,
  InferCreationAttributes<ClassSchedule>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare batchId: number;
  declare subjectId: number | null;
  declare teacherUserId: number;
  declare classroomId: number | null;
  declare dayOfWeek: number;
  declare startTime: string;
  declare endTime: string;
  declare effectiveFrom: string;
  declare effectiveTo: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ClassSession extends Model<
  InferAttributes<ClassSession>,
  InferCreationAttributes<ClassSession>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number;
  declare batchId: number;
  declare subjectId: number | null;
  declare scheduleId: number | null;
  declare teacherUserId: number;
  declare originalTeacherUserId: CreationOptional<number | null>;
  declare classroomId: number | null;
  declare occurrenceDate: CreationOptional<string | null>;
  declare date: string;
  declare startTime: string;
  declare endTime: string;
  declare status: CreationOptional<ClassSessionStatus>;
  declare rescheduledFrom: CreationOptional<string | null>;
  declare cancelReason: CreationOptional<string | null>;
  declare actualDurationMinutes: CreationOptional<number | null>;
  declare completionNotes: CreationOptional<string | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare batch?: NonAttribute<Batch>;
  declare subject?: NonAttribute<Subject | null>;
  declare teacher?: NonAttribute<User>;
  declare classroom?: NonAttribute<Classroom | null>;
}

export class ClassNote extends Model<InferAttributes<ClassNote>, InferCreationAttributes<ClassNote>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare classSessionId: number;
  declare authorUserId: number;
  declare kind: CreationOptional<ClassNoteKind>;
  declare title: string;
  declare body: string | null;
  declare dueDate: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare attachments?: NonAttribute<ClassNoteAttachment[]>;
  declare comments?: NonAttribute<ClassNoteComment[]>;
}

export class ClassNoteAttachment extends Model<
  InferAttributes<ClassNoteAttachment>,
  InferCreationAttributes<ClassNoteAttachment>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare classNoteId: number;
  declare fileId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject>;
}

export class ClassNoteComment extends Model<
  InferAttributes<ClassNoteComment>,
  InferCreationAttributes<ClassNoteComment>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare classNoteId: number;
  declare userId: number;
  declare body: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const dateOnly = (allowNull = false) => ({ type: DataTypes.DATEONLY, allowNull });

/** TIME columns come back as `HH:MM:SS`; the API speaks `HH:MM`. */
const hhmm = (field: string) => ({
  type: DataTypes.TIME,
  allowNull: false,
  get(this: Model) {
    const v = this.getDataValue(field) as string | null;
    return v ? v.slice(0, 5) : v;
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
    {
      sequelize,
      tableName,
    },
  );
  registerTenantModel(model);
}

export function initAcademicsModels(sequelize: Sequelize) {
  define(AcademicSession, sequelize, 'academic_sessions', {
    name: str(80),
    startDate: dateOnly(),
    endDate: dateOnly(),
    isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { ...str(20), defaultValue: 'planned' },
  });
  define(CourseCategory, sequelize, 'course_categories', {
    name: str(120),
    description: { type: DataTypes.TEXT, allowNull: true },
  });
  define(Course, sequelize, 'courses', {
    categoryId: uint(),
    templateId: uint(),
    name: str(150),
    code: str(30),
    description: { type: DataTypes.TEXT, allowNull: true },
    mode: { ...str(10), defaultValue: 'offline' },
    durationValue: uint(),
    durationUnit: str(10, true),
    isTemplate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { ...str(20), defaultValue: 'active' },
  });
  define(CourseBranch, sequelize, 'course_branches', { branchId: uint(false), courseId: uint(false) });
  define(Subject, sequelize, 'subjects', { name: str(120), code: str(30, true) });
  define(CourseSubject, sequelize, 'course_subjects', {
    courseId: uint(false),
    subjectId: uint(false),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  define(Chapter, sequelize, 'chapters', {
    subjectId: uint(false),
    name: str(150),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  define(Topic, sequelize, 'topics', {
    chapterId: uint(false),
    name: str(150),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    durationMinutes: uint(),
  });
  define(Batch, sequelize, 'batches', {
    branchId: uint(false),
    courseId: uint(false),
    academicSessionId: uint(false),
    name: str(120),
    code: str(30),
    capacity: uint(false),
    startDate: dateOnly(),
    endDate: dateOnly(true),
    mode: { ...str(10), defaultValue: 'offline' },
    status: { ...str(20), defaultValue: 'planned' },
  });
  define(BatchTeacher, sequelize, 'batch_teachers', {
    batchId: uint(false),
    subjectId: uint(),
    teacherUserId: uint(false),
  });
  define(BatchStudent, sequelize, 'batch_students', {
    batchId: uint(false),
    studentUserId: uint(false),
    status: { ...str(20), defaultValue: 'active' },
    joinedOn: dateOnly(),
    leftOn: dateOnly(true),
    promotedFromId: uint(),
  });
  define(StudentPromotion, sequelize, 'student_promotions', {
    studentUserId: uint(false),
    fromBatchId: uint(false),
    toBatchId: uint(false),
    fromSessionId: uint(false),
    toSessionId: uint(false),
    promotedByUserId: uint(),
  });
  define(Classroom, sequelize, 'classrooms', {
    branchId: uint(false),
    name: str(80),
    capacity: uint(false),
    isVirtual: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { ...str(20), defaultValue: 'active' },
  });
  define(ClassSchedule, sequelize, 'class_schedules', {
    branchId: uint(false),
    batchId: uint(false),
    subjectId: uint(),
    teacherUserId: uint(false),
    classroomId: uint(),
    dayOfWeek: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    startTime: hhmm('startTime'),
    endTime: hhmm('endTime'),
    effectiveFrom: dateOnly(),
    effectiveTo: dateOnly(true),
  });
  define(ClassSession, sequelize, 'class_sessions', {
    branchId: uint(false),
    batchId: uint(false),
    subjectId: uint(),
    scheduleId: uint(),
    teacherUserId: uint(false),
    originalTeacherUserId: uint(),
    classroomId: uint(),
    occurrenceDate: dateOnly(true),
    date: dateOnly(),
    startTime: hhmm('startTime'),
    endTime: hhmm('endTime'),
    status: { ...str(20), defaultValue: 'scheduled' },
    rescheduledFrom: str(40, true),
    cancelReason: str(500, true),
    actualDurationMinutes: uint(),
    completionNotes: { type: DataTypes.TEXT, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
  });
  define(ClassNote, sequelize, 'class_notes', {
    classSessionId: uint(false),
    authorUserId: uint(false),
    kind: { ...str(20), defaultValue: 'note' },
    title: str(200),
    body: { type: DataTypes.TEXT, allowNull: true },
    dueDate: dateOnly(true),
  });
  define(ClassNoteAttachment, sequelize, 'class_note_attachments', {
    classNoteId: uint(false),
    fileId: uint(false),
  });
  define(ClassNoteComment, sequelize, 'class_note_comments', {
    classNoteId: uint(false),
    userId: uint(false),
    body: { type: DataTypes.TEXT, allowNull: false },
  });
}

export const userRef = { attributes: ['id', 'name'] };

export function associateAcademicsModels() {
  Course.hasMany(CourseBranch, { foreignKey: 'courseId', as: 'branchLinks' });
  Course.hasMany(CourseSubject, { foreignKey: 'courseId', as: 'subjectLinks' });
  Batch.hasMany(BatchTeacher, { foreignKey: 'batchId', as: 'teachers' });
  Batch.belongsTo(Course, { foreignKey: 'courseId', as: 'course' });
  BatchTeacher.belongsTo(User, { foreignKey: 'teacherUserId', as: 'teacher' });
  BatchStudent.belongsTo(User, { foreignKey: 'studentUserId', as: 'student' });
  BatchStudent.belongsTo(Batch, { foreignKey: 'batchId', as: 'batch' });
  ClassSession.belongsTo(Batch, { foreignKey: 'batchId', as: 'batch' });
  ClassSession.belongsTo(Subject, { foreignKey: 'subjectId', as: 'subject' });
  ClassSession.belongsTo(User, { foreignKey: 'teacherUserId', as: 'teacher' });
  ClassSession.belongsTo(Classroom, { foreignKey: 'classroomId', as: 'classroom' });
  ClassNote.hasMany(ClassNoteAttachment, { foreignKey: 'classNoteId', as: 'attachments' });
  ClassNote.hasMany(ClassNoteComment, { foreignKey: 'classNoteId', as: 'comments' });
  ClassNoteAttachment.belongsTo(FileObject, { foreignKey: 'fileId', as: 'file' });
  ClassNoteComment.belongsTo(User, { foreignKey: 'userId', as: 'user' });
}
