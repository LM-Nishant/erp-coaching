import { DataTypes } from 'sequelize';
import type { Migration } from '../migration-helpers';

const PATHS = ['$.after.branchId', '$.before.branchId', '$.branchId'];

/**
 * The branch an audit event belongs to, so branch-restricted users see only their branches'
 * entries. Existing rows take the `branchId` recorded in their metadata, if any. No foreign key:
 * the trail outlives deleted branches.
 */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.addColumn('audit_events', 'branch_id', { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
  const value = (p: string) => `JSON_VALUE(metadata, '${p}' RETURNING UNSIGNED NULL ON EMPTY NULL ON ERROR)`;
  await q.sequelize.query(
    `UPDATE audit_events SET branch_id = NULLIF(COALESCE(${PATHS.map(value).join(', ')}), 0)
     WHERE institute_id IS NOT NULL AND metadata IS NOT NULL
       AND JSON_CONTAINS_PATH(metadata, 'one', ${PATHS.map((p) => `'${p}'`).join(', ')})`,
  );
  await q.addIndex('audit_events', ['institute_id', 'branch_id', 'id'], {
    name: 'audit_events_institute_branch_id',
  });
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  await q.removeIndex('audit_events', 'audit_events_institute_branch_id');
  await q.removeColumn('audit_events', 'branch_id');
};
