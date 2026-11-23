import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Marketplace learner engagement: ratings & reviews (one per enrolled learner and course), course Q&A
 * and the wishlist. Platform-wide like the rest of the marketplace (no `institute_id`).
 */
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const count = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const text = () => ({ type: DataTypes.TEXT, allowNull: true });
const date = () => ({ type: DataTypes.DATE, allowNull: true });

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('mkt_reviews', {
    id: id(),
    course_id: fk('mkt_courses'),
    user_id: fk('users'),
    rating: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    title: str(150, true),
    body: text(),
    status: { ...str(20), defaultValue: 'visible' },
    report_count: count(),
    hidden_reason: str(500, true),
    hidden_at: date(),
    reply_body: text(),
    reply_by_user_id: fk('users', { allowNull: true }),
    replied_at: date(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_reviews', ['course_id', 'user_id'], { unique: true });
  await qi.addIndex('mkt_reviews', ['course_id', 'status', 'created_at']);
  await qi.addIndex('mkt_reviews', ['status', 'report_count']);

  await qi.createTable('mkt_review_reports', {
    id: id(),
    review_id: fk('mkt_reviews'),
    user_id: fk('users'),
    reason: str(500),
    ...timestamps(),
  });
  await qi.addIndex('mkt_review_reports', ['review_id', 'user_id'], { unique: true });

  await qi.createTable('mkt_questions', {
    id: id(),
    course_id: fk('mkt_courses'),
    lecture_id: fk('mkt_lectures', { allowNull: true }),
    user_id: fk('users'),
    title: str(200),
    body: text(),
    answered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    answer_count: count(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_questions', ['course_id', 'created_at']);
  await qi.addIndex('mkt_questions', ['course_id', 'lecture_id']);

  await qi.createTable('mkt_answers', {
    id: id(),
    question_id: fk('mkt_questions'),
    user_id: fk('users'),
    body: { type: DataTypes.TEXT, allowNull: false },
    is_instructor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps(),
  });
  await qi.addIndex('mkt_answers', ['question_id', 'created_at']);

  await qi.createTable('mkt_wishlist_items', {
    id: id(),
    user_id: fk('users'),
    course_id: fk('mkt_courses'),
    ...timestamps(),
  });
  await qi.addIndex('mkt_wishlist_items', ['user_id', 'course_id'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const t of ['mkt_wishlist_items', 'mkt_answers', 'mkt_questions', 'mkt_review_reports', 'mkt_reviews'])
    await qi.dropTable(t);
};
