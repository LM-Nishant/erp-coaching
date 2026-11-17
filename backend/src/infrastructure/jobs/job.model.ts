import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type Sequelize } from 'sequelize';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export class Job extends Model<InferAttributes<Job>, InferCreationAttributes<Job>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare instituteId: number | null;
  declare payload: Record<string, unknown>;
  declare status: CreationOptional<JobStatus>;
  declare attempts: CreationOptional<number>;
  declare maxAttempts: CreationOptional<number>;
  declare runAt: CreationOptional<Date>;
  declare lockedAt: Date | null;
  declare lastError: string | null;
  declare completedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    Job.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING(120), allowNull: false },
        instituteId: DataTypes.INTEGER.UNSIGNED,
        payload: { type: DataTypes.JSON, allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
        runAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        lockedAt: DataTypes.DATE,
        lastError: DataTypes.TEXT,
        completedAt: DataTypes.DATE,
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'jobs' },
    );
  }
}
