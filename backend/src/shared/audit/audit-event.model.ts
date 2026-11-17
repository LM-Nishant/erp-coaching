import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type Sequelize } from 'sequelize';

export class AuditEvent extends Model<InferAttributes<AuditEvent>, InferCreationAttributes<AuditEvent>> {
  declare id: CreationOptional<number>;
  declare instituteId: number | null;
  declare actorUserId: number | null;
  declare impersonatorUserId: number | null;
  declare action: string;
  declare entityType: string | null;
  declare entityId: string | null;
  declare metadata: Record<string, unknown> | null;
  declare ip: string | null;
  declare userAgent: string | null;
  declare createdAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    AuditEvent.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: DataTypes.INTEGER.UNSIGNED,
        actorUserId: DataTypes.INTEGER.UNSIGNED,
        impersonatorUserId: DataTypes.INTEGER.UNSIGNED,
        action: { type: DataTypes.STRING(120), allowNull: false },
        entityType: DataTypes.STRING(80),
        entityId: DataTypes.STRING(64),
        metadata: DataTypes.JSON,
        ip: DataTypes.STRING(64),
        userAgent: DataTypes.STRING(255),
        createdAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'audit_events', updatedAt: false },
    );
  }
}
