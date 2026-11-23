import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('question_imports', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    bank_id: fk('question_banks'),
    created_by_user_id: fk('users', { allowNull: true }),
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'queued' },
    file_id: fk('files', { allowNull: true }),
    answer_key_file_id: fk('files', { allowNull: true }),
    file_name: { type: DataTypes.STRING(255), allowNull: false },
    answer_key_file_name: { type: DataTypes.STRING(255), allowNull: true },
    page_count: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    pages_done: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    drafts: { type: DataTypes.JSON, allowNull: true },
    warnings: { type: DataTypes.JSON, allowNull: true },
    error: { type: DataTypes.STRING(500), allowNull: true },
    model: { type: DataTypes.STRING(100), allowNull: true },
    vision_pages: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    total_tokens: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    saved_count: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('question_imports', ['institute_id', 'bank_id', 'status']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.dropTable('question_imports');
};
