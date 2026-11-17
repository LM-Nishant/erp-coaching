import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** `source_ref` identifies system-created resources (e.g. live class recordings) for idempotent imports. */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('lms_resources', 'source_ref', {
    type: DataTypes.STRING(100),
    allowNull: true,
  });
  await qi.addIndex('lms_resources', ['institute_id', 'source_ref'], {
    unique: true,
    name: 'lms_resources_institute_source_ref',
  });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeIndex('lms_resources', 'lms_resources_institute_source_ref');
  await qi.removeColumn('lms_resources', 'source_ref');
};
