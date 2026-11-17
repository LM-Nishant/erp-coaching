import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('live_sessions', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    batch_id: fk('batches'),
    course_id: fk('courses', { allowNull: true }),
    subject_id: fk('subjects', { allowNull: true }),
    class_session_id: fk('class_sessions', { allowNull: true }),
    teacher_user_id: { ...fk('users'), onDelete: 'RESTRICT' },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    scheduled_start_at: { type: DataTypes.DATE, allowNull: false },
    scheduled_end_at: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'scheduled' },
    started_at: { type: DataTypes.DATE, allowNull: true },
    ended_at: { type: DataTypes.DATE, allowNull: true },
    recording_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    provider: { type: DataTypes.STRING(30), allowNull: false },
    room_id: { type: DataTypes.STRING(120), allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('live_sessions', ['institute_id', 'branch_id', 'scheduled_start_at']);
  await queryInterface.addIndex('live_sessions', ['institute_id', 'batch_id', 'status']);
  await queryInterface.addIndex('live_sessions', ['institute_id', 'teacher_user_id']);
  await queryInterface.addIndex('live_sessions', ['institute_id', 'class_session_id']);

  await queryInterface.createTable('live_participants', {
    id: id(),
    ...tenantColumns(),
    live_session_id: fk('live_sessions'),
    user_id: fk('users'),
    role: { type: DataTypes.STRING(20), allowNull: false },
    first_joined_at: { type: DataTypes.DATE, allowNull: true },
    last_joined_at: { type: DataTypes.DATE, allowNull: true },
    last_left_at: { type: DataTypes.DATE, allowNull: true },
    total_seconds: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    join_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    is_online: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps(),
  });
  await queryInterface.addIndex('live_participants', ['institute_id', 'live_session_id', 'user_id'], {
    unique: true,
  });

  await queryInterface.createTable('live_chat_messages', {
    id: id(),
    ...tenantColumns(),
    live_session_id: fk('live_sessions'),
    user_id: fk('users'),
    kind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'chat' },
    body: { type: DataTypes.STRING(1000), allowNull: false },
    upvotes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    is_answered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    answered_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('live_chat_messages', ['institute_id', 'live_session_id', 'kind', 'id']);

  await queryInterface.createTable('live_question_votes', {
    id: id(),
    ...tenantColumns(),
    message_id: fk('live_chat_messages'),
    user_id: fk('users'),
    ...timestamps(),
  });
  await queryInterface.addIndex('live_question_votes', ['institute_id', 'message_id', 'user_id'], {
    unique: true,
  });

  await queryInterface.createTable('live_polls', {
    id: id(),
    ...tenantColumns(),
    live_session_id: fk('live_sessions'),
    created_by_user_id: fk('users'),
    question: { type: DataTypes.STRING(300), allowNull: false },
    options: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'open' },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('live_polls', ['institute_id', 'live_session_id']);

  await queryInterface.createTable('live_poll_responses', {
    id: id(),
    ...tenantColumns(),
    poll_id: fk('live_polls'),
    user_id: fk('users'),
    option_index: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    ...timestamps(),
  });
  await queryInterface.addIndex('live_poll_responses', ['institute_id', 'poll_id', 'user_id'], {
    unique: true,
  });

  await queryInterface.createTable('live_recordings', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    live_session_id: fk('live_sessions'),
    batch_id: fk('batches'),
    course_id: fk('courses', { allowNull: true }),
    file_id: { ...fk('files'), onDelete: 'RESTRICT' },
    title: { type: DataTypes.STRING(200), allowNull: false },
    duration_seconds: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    source: { type: DataTypes.STRING(20), allowNull: false },
    provider_ref: { type: DataTypes.STRING(191), allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('live_recordings', ['institute_id', 'batch_id', 'created_at']);
  await queryInterface.addIndex('live_recordings', ['institute_id', 'live_session_id']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  for (const t of [
    'live_recordings',
    'live_poll_responses',
    'live_polls',
    'live_question_votes',
    'live_chat_messages',
    'live_participants',
    'live_sessions',
  ])
    await queryInterface.dropTable(t);
};
