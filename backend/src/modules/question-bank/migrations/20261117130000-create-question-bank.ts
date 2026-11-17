import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('question_banks', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    description: { type: DataTypes.STRING(1000), allowNull: true },
    subject_id: fk('subjects', { allowNull: true }),
    visibility: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'shared' },
    owner_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('question_banks', ['institute_id', 'branch_id']);
  await qi.addIndex('question_banks', ['institute_id', 'owner_user_id']);

  await qi.createTable('questions', {
    id: id(),
    ...tenantColumns(),
    bank_id: fk('question_banks'),
    type: { type: DataTypes.STRING(15), allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: false },
    options: { type: DataTypes.JSON, allowNull: true },
    answer_key: { type: DataTypes.JSON, allowNull: false },
    explanation: { type: DataTypes.TEXT, allowNull: true },
    difficulty: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'medium' },
    tags: { type: DataTypes.JSON, allowNull: true },
    subject_id: fk('subjects', { allowNull: true }),
    chapter_id: fk('chapters', { allowNull: true }),
    topic_id: fk('topics', { allowNull: true }),
    default_marks: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 1 },
    default_negative_marks: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
    source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'manual' },
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('questions', ['institute_id', 'bank_id']);
  await qi.addIndex('questions', ['institute_id', 'subject_id', 'chapter_id', 'topic_id']);
  await qi.addIndex('questions', ['institute_id', 'type', 'difficulty']);

  await qi.createTable('question_assets', {
    id: id(),
    ...tenantColumns(),
    question_id: fk('questions'),
    file_id: fk('files'),
    role: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'question' },
    sort_order: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('question_assets', ['institute_id', 'question_id']);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.dropTable('question_assets');
  await qi.dropTable('questions');
  await qi.dropTable('question_banks');
};
