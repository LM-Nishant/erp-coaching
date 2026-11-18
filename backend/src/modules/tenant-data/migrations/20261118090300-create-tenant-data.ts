import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

/** Institute data exports (tenant) and the institute deletion workflow (kept after the purge). */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.createTable('data_exports', {
    id: id(),
    ...tenantColumns(),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    include_media: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requested_by: fk('users', { allowNull: true }),
    requested_by_name: { type: DataTypes.STRING(150), allowNull: true },
    storage_key: { type: DataTypes.STRING(500), allowNull: true },
    size_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    table_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    row_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    file_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('data_exports', ['institute_id', 'status']);
  await q.addIndex('data_exports', ['status', 'expires_at']);

  await q.createTable('institute_deletion_requests', {
    id: id(),
    // SET NULL: the request is the permanent record of the deletion and outlives the institute.
    institute_id: fk('institutes', { allowNull: true }),
    institute_ref_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    institute_name: { type: DataTypes.STRING(200), allowNull: false },
    institute_slug: { type: DataTypes.STRING(100), allowNull: false },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
    reason: { type: DataTypes.STRING(1000), allowNull: true },
    requested_by: fk('users', { allowNull: true }),
    requested_by_name: { type: DataTypes.STRING(150), allowNull: true },
    decided_by: fk('users', { allowNull: true }),
    decided_at: { type: DataTypes.DATE, allowNull: true },
    decision_note: { type: DataTypes.STRING(1000), allowNull: true },
    previous_institute_status: { type: DataTypes.STRING(20), allowNull: true },
    scheduled_for: { type: DataTypes.DATE, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    summary: { type: DataTypes.JSON, allowNull: true },
    pending_user_ids: { type: DataTypes.JSON, allowNull: true },
    error: { type: DataTypes.STRING(2000), allowNull: true },
    ...timestamps(),
  });
  await q.addIndex('institute_deletion_requests', ['institute_id', 'status']);
  await q.addIndex('institute_deletion_requests', ['status', 'scheduled_for']);
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.dropTable('institute_deletion_requests');
  await q.dropTable('data_exports');
};
