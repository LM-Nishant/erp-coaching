import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

/** Marketplace quizzes (questions + learner attempts) and course completion certificates. Platform-wide. */
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const json = (allowNull = false) => ({ type: DataTypes.JSON, allowNull });

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('mkt_quizzes', {
    id: id(),
    lecture_id: fk('mkt_lectures'),
    pass_percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 70 },
    max_attempts: uint(),
    shuffle: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps(),
  });
  await qi.addIndex('mkt_quizzes', ['lecture_id'], { unique: true });

  await qi.createTable('mkt_quiz_questions', {
    id: id(),
    lecture_id: fk('mkt_lectures'),
    kind: str(10),
    prompt: { type: DataTypes.TEXT, allowNull: false },
    options: json(),
    correct: json(),
    explanation: { type: DataTypes.TEXT, allowNull: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('mkt_quiz_questions', ['lecture_id', 'sort_order']);

  await qi.createTable('mkt_quiz_attempts', {
    id: id(),
    user_id: fk('users'),
    course_id: fk('mkt_courses'),
    lecture_id: fk('mkt_lectures'),
    answers: json(),
    score: uint(false),
    total: uint(false),
    percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    passed: { type: DataTypes.BOOLEAN, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('mkt_quiz_attempts', ['user_id', 'lecture_id']);

  await qi.createTable('mkt_certificates', {
    id: id(),
    code: str(20),
    user_id: fk('users'),
    course_id: fk('mkt_courses', { onDelete: 'RESTRICT' }),
    // Snapshots: the certificate keeps the names it was issued with.
    learner_name: str(150),
    course_title: str(160),
    seller_name: str(150),
    issued_at: { type: DataTypes.DATE, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('mkt_certificates', ['code'], { unique: true });
  await qi.addIndex('mkt_certificates', ['user_id', 'course_id'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const t of ['mkt_certificates', 'mkt_quiz_attempts', 'mkt_quiz_questions', 'mkt_quizzes'])
    await qi.dropTable(t);
};
