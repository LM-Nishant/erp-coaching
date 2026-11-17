import { DataTypes, type QueryInterface } from 'sequelize';

/** Migration context passed to every migration/seeder `up`/`down`. */
export interface MigrationContext {
  queryInterface: QueryInterface;
}
export type Migration = (params: { context: MigrationContext }) => Promise<void>;

export const id = () => ({
  type: DataTypes.INTEGER.UNSIGNED,
  autoIncrement: true,
  primaryKey: true,
  allowNull: false,
});

export const timestamps = () => ({
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
});

export const fk = (table: string, opts: { allowNull?: boolean; onDelete?: string } = {}) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull: opts.allowNull ?? false,
  references: { model: table, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: opts.onDelete ?? (opts.allowNull ? 'SET NULL' : 'CASCADE'),
});

/** Required tenant columns. Every tenant-owned table MUST include `institute_id`. */
export const tenantColumns = (opts: { branch?: 'required' | 'optional' } = {}) => ({
  institute_id: fk('institutes'),
  ...(opts.branch
    ? { branch_id: fk('branches', { allowNull: opts.branch === 'optional', onDelete: 'RESTRICT' }) }
    : {}),
});
