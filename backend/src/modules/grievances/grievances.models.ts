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
  GrievanceActivityType,
  GrievancePriority,
  GrievanceRequesterType,
  GrievanceStatus,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';
import { FileObject } from '../files/file.model';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

export class GrievanceSetting extends Model<
  InferAttributes<GrievanceSetting>,
  InferCreationAttributes<GrievanceSetting>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare ticketPrefix: CreationOptional<string>;
  declare defaultSlaHours: CreationOptional<number>;
  declare escalationUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    GrievanceSetting.init(
      {
        id: pk,
        instituteId: uint(false),
        ticketPrefix: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'GRV' },
        defaultSlaHours: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 72 },
        escalationUserId: uint(),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'grievance_settings' },
    );
    registerTenantModel(GrievanceSetting);
  }
}

export class GrievanceCategory extends Model<
  InferAttributes<GrievanceCategory>,
  InferCreationAttributes<GrievanceCategory>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare name: string;
  declare description: string | null;
  declare defaultAssigneeUserId: number | null;
  declare slaHours: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare defaultAssignee?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    GrievanceCategory.init(
      {
        id: pk,
        instituteId: uint(false),
        name: { type: DataTypes.STRING(100), allowNull: false },
        description: DataTypes.STRING(500),
        defaultAssigneeUserId: uint(),
        slaHours: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 72 },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'grievance_categories' },
    );
    registerTenantModel(GrievanceCategory);
  }
}

export class GrievanceTicket extends Model<
  InferAttributes<GrievanceTicket>,
  InferCreationAttributes<GrievanceTicket>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare ticketNumber: string;
  declare categoryId: number;
  declare subject: string;
  declare description: string;
  declare priority: CreationOptional<GrievancePriority>;
  declare status: CreationOptional<GrievanceStatus>;
  declare requesterType: GrievanceRequesterType;
  declare requesterUserId: number;
  declare onBehalfOfUserId: number | null;
  declare assigneeUserId: number | null;
  declare dueAt: Date | null;
  declare firstResponseAt: CreationOptional<Date | null>;
  declare resolvedAt: CreationOptional<Date | null>;
  declare closedAt: CreationOptional<Date | null>;
  declare escalatedAt: CreationOptional<Date | null>;
  declare escalationLevel: CreationOptional<number>;
  declare slaBreached: CreationOptional<boolean>;
  declare reopenCount: CreationOptional<number>;
  declare resolutionNotes: CreationOptional<string | null>;
  declare closureConfirmed: CreationOptional<boolean | null>;
  declare satisfactionRating: CreationOptional<number | null>;
  declare closureFeedback: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare category?: NonAttribute<GrievanceCategory | null>;
  declare requester?: NonAttribute<User | null>;
  declare onBehalfOf?: NonAttribute<User | null>;
  declare assignee?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    GrievanceTicket.init(
      {
        id: pk,
        instituteId: uint(false),
        branchId: uint(),
        ticketNumber: { type: DataTypes.STRING(30), allowNull: false },
        categoryId: uint(false),
        subject: { type: DataTypes.STRING(200), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: false },
        priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'medium' },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
        requesterType: { type: DataTypes.STRING(10), allowNull: false },
        requesterUserId: uint(false),
        onBehalfOfUserId: uint(),
        assigneeUserId: uint(),
        dueAt: DataTypes.DATE,
        firstResponseAt: DataTypes.DATE,
        resolvedAt: DataTypes.DATE,
        closedAt: DataTypes.DATE,
        escalatedAt: DataTypes.DATE,
        escalationLevel: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        slaBreached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        reopenCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        resolutionNotes: DataTypes.TEXT,
        closureConfirmed: DataTypes.BOOLEAN,
        satisfactionRating: DataTypes.TINYINT.UNSIGNED,
        closureFeedback: DataTypes.STRING(1000),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'grievance_tickets' },
    );
    registerTenantModel(GrievanceTicket);
  }
}

export class GrievanceActivity extends Model<
  InferAttributes<GrievanceActivity>,
  InferCreationAttributes<GrievanceActivity>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare ticketId: number;
  declare authorUserId: number | null;
  declare type: GrievanceActivityType;
  declare isInternal: CreationOptional<boolean>;
  declare body: string | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare author?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    GrievanceActivity.init(
      {
        id: pk,
        instituteId: uint(false),
        ticketId: uint(false),
        authorUserId: uint(),
        type: { type: DataTypes.STRING(20), allowNull: false },
        isInternal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        body: DataTypes.TEXT,
        metadata: DataTypes.JSON,
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'grievance_activities' },
    );
    registerTenantModel(GrievanceActivity);
  }
}

export class GrievanceAttachment extends Model<
  InferAttributes<GrievanceAttachment>,
  InferCreationAttributes<GrievanceAttachment>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare ticketId: number;
  declare activityId: number | null;
  declare fileId: number;
  declare uploadedByUserId: number | null;
  declare isInternal: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare file?: NonAttribute<FileObject | null>;

  static initModel(sequelize: Sequelize) {
    GrievanceAttachment.init(
      {
        id: pk,
        instituteId: uint(false),
        ticketId: uint(false),
        activityId: uint(),
        fileId: uint(false),
        uploadedByUserId: uint(),
        isInternal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'grievance_attachments' },
    );
    registerTenantModel(GrievanceAttachment);
  }
}

export function initGrievanceModels(sequelize: Sequelize) {
  GrievanceSetting.initModel(sequelize);
  GrievanceCategory.initModel(sequelize);
  GrievanceTicket.initModel(sequelize);
  GrievanceActivity.initModel(sequelize);
  GrievanceAttachment.initModel(sequelize);
}

const USER_ATTRS = ['id', 'name'];

export function associateGrievanceModels() {
  GrievanceCategory.belongsTo(User, { as: 'defaultAssignee', foreignKey: 'defaultAssigneeUserId' });
  GrievanceTicket.belongsTo(GrievanceCategory, { as: 'category', foreignKey: 'categoryId' });
  GrievanceTicket.belongsTo(User, { as: 'requester', foreignKey: 'requesterUserId' });
  GrievanceTicket.belongsTo(User, { as: 'onBehalfOf', foreignKey: 'onBehalfOfUserId' });
  GrievanceTicket.belongsTo(User, { as: 'assignee', foreignKey: 'assigneeUserId' });
  GrievanceActivity.belongsTo(User, { as: 'author', foreignKey: 'authorUserId' });
  GrievanceAttachment.belongsTo(FileObject, { as: 'file', foreignKey: 'fileId' });
}

/** Standard includes for ticket DTOs. */
export const ticketIncludes = () => [
  { model: GrievanceCategory, as: 'category', attributes: ['id', 'name'] },
  { model: User, as: 'requester', attributes: USER_ATTRS },
  { model: User, as: 'onBehalfOf', attributes: USER_ATTRS },
  { model: User, as: 'assignee', attributes: USER_ATTRS },
];
export const userInclude = (as: string) => ({ model: User, as, attributes: USER_ATTRS });
