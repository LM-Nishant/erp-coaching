import { DataTypes } from 'sequelize';
import { fk, id, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Public course marketplace. Platform-wide tables: none has `institute_id` (a seller may be an independent
 * instructor); an institute's storefront is the seller row with `owner_institute_id`.
 */
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const count = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const paise = () => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 });
const date = () => ({ type: DataTypes.DATE, allowNull: true });
const json = () => ({ type: DataTypes.JSON, allowNull: true });

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('mkt_settings', {
    id: id(),
    commission_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 30 },
    instructor_signup_open: bool(true),
    ...timestamps(),
  });

  await qi.createTable('mkt_sellers', {
    id: id(),
    type: str(20),
    slug: str(120),
    display_name: str(150),
    headline: str(200, true),
    bio: { type: DataTypes.TEXT, allowNull: true },
    website: str(300, true),
    avatar_media_id: uint(),
    owner_institute_id: fk('institutes', { allowNull: true }),
    user_id: fk('users', { allowNull: true }),
    status: { ...str(20), defaultValue: 'active' },
    commission_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('mkt_sellers', ['slug'], { unique: true });
  await qi.addIndex('mkt_sellers', ['owner_institute_id'], { unique: true });
  await qi.addIndex('mkt_sellers', ['user_id'], { unique: true });

  await qi.createTable('mkt_media', {
    id: id(),
    seller_id: fk('mkt_sellers'),
    uploaded_by_user_id: fk('users', { allowNull: true }),
    kind: str(10),
    original_name: str(255),
    mime_type: str(150),
    size_bytes: paise(),
    received_bytes: paise(),
    storage_key: str(400),
    status: { ...str(20), defaultValue: 'uploading' },
    error: str(500, true),
    duration_seconds: uint(),
    hls_prefix: str(300, true),
    ...timestamps(),
  });
  await qi.addIndex('mkt_media', ['seller_id', 'kind']);
  await qi.addConstraint('mkt_sellers', {
    type: 'foreign key',
    fields: ['avatar_media_id'],
    name: 'mkt_sellers_avatar_media_fk',
    references: { table: 'mkt_media', field: 'id' },
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });

  await qi.createTable('mkt_categories', {
    id: id(),
    parent_id: fk('mkt_categories', { allowNull: true, onDelete: 'CASCADE' }),
    slug: str(120),
    name: str(120),
    icon: str(60, true),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('mkt_categories', ['slug'], { unique: true });

  await qi.createTable('mkt_courses', {
    id: id(),
    seller_id: fk('mkt_sellers', { onDelete: 'RESTRICT' }),
    slug: str(160),
    title: str(160),
    subtitle: str(250, true),
    description: { type: DataTypes.TEXT, allowNull: true },
    category_id: fk('mkt_categories', { allowNull: true }),
    subcategory_id: fk('mkt_categories', { allowNull: true }),
    level: { ...str(20), defaultValue: 'all' },
    language: { ...str(10), defaultValue: 'en' },
    price_paise: paise(),
    outcomes: json(),
    requirements: json(),
    audience: json(),
    thumbnail_media_id: fk('mkt_media', { allowNull: true }),
    promo_media_id: fk('mkt_media', { allowNull: true }),
    status: { ...str(20), defaultValue: 'draft' },
    review_note: str(1000, true),
    submitted_at: date(),
    reviewed_at: date(),
    reviewed_by_user_id: fk('users', { allowNull: true }),
    published_at: date(),
    // Reviews (wave 2) keep these up to date; the catalog sorts and filters on them already.
    rating_avg: { type: DataTypes.DECIMAL(3, 2), allowNull: false, defaultValue: 0 },
    rating_count: count(),
    enrolment_count: count(),
    lecture_count: count(),
    duration_seconds: count(),
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('mkt_courses', ['slug'], { unique: true });
  await qi.addIndex('mkt_courses', ['status', 'published_at']);
  await qi.addIndex('mkt_courses', ['seller_id', 'status']);

  await qi.createTable('mkt_sections', {
    id: id(),
    course_id: fk('mkt_courses'),
    title: str(200),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('mkt_sections', ['course_id', 'sort_order']);

  await qi.createTable('mkt_lectures', {
    id: id(),
    course_id: fk('mkt_courses'),
    section_id: fk('mkt_sections'),
    title: str(200),
    type: str(20),
    description: { type: DataTypes.TEXT, allowNull: true },
    article_body: { type: DataTypes.TEXT('medium'), allowNull: true },
    media_id: fk('mkt_media', { allowNull: true }),
    preview: bool(false),
    duration_seconds: count(),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('mkt_lectures', ['section_id', 'sort_order']);
  await qi.addIndex('mkt_lectures', ['course_id']);

  await qi.createTable('mkt_cart_items', {
    id: id(),
    user_id: fk('users'),
    course_id: fk('mkt_courses'),
    ...timestamps(),
  });
  await qi.addIndex('mkt_cart_items', ['user_id', 'course_id'], { unique: true });

  await qi.createTable('mkt_coupons', {
    id: id(),
    seller_id: fk('mkt_sellers', { allowNull: true, onDelete: 'CASCADE' }),
    code: str(40),
    kind: str(10),
    value: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    course_ids: json(),
    max_uses: uint(),
    used_count: count(),
    valid_from: date(),
    valid_until: date(),
    active: bool(true),
    created_by_user_id: fk('users', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('mkt_coupons', ['code'], { unique: true });

  await qi.createTable('mkt_orders', {
    id: id(),
    number: str(30),
    user_id: fk('users', { onDelete: 'RESTRICT' }),
    status: { ...str(20), defaultValue: 'pending' },
    subtotal_paise: paise(),
    discount_paise: paise(),
    total_paise: paise(),
    coupon_id: fk('mkt_coupons', { allowNull: true }),
    coupon_code: str(40, true),
    gateway: str(20, true),
    gateway_order_id: str(120, true),
    gateway_payment_id: str(120, true),
    checkout_payload: json(),
    idempotency_key: str(160, true),
    buyer_name: str(150),
    buyer_mobile: str(20, true),
    buyer_email: str(190, true),
    failure_reason: str(300, true),
    paid_at: date(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_orders', ['number'], { unique: true });
  await qi.addIndex('mkt_orders', ['gateway', 'gateway_order_id'], { unique: true });
  await qi.addIndex('mkt_orders', ['user_id', 'idempotency_key'], { unique: true });
  await qi.addIndex('mkt_orders', ['user_id', 'status']);

  await qi.createTable('mkt_order_items', {
    id: id(),
    order_id: fk('mkt_orders'),
    course_id: fk('mkt_courses', { onDelete: 'RESTRICT' }),
    seller_id: fk('mkt_sellers', { onDelete: 'RESTRICT' }),
    title: str(160),
    price_paise: paise(),
    discount_paise: paise(),
    paid_paise: paise(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_order_items', ['order_id', 'course_id'], { unique: true });

  await qi.createTable('mkt_webhook_events', {
    id: id(),
    gateway: str(20),
    event_key: str(191),
    order_id: uint(),
    outcome: str(30),
    ...timestamps(),
  });
  await qi.addIndex('mkt_webhook_events', ['gateway', 'event_key'], { unique: true });

  await qi.createTable('mkt_enrolments', {
    id: id(),
    user_id: fk('users'),
    course_id: fk('mkt_courses'),
    order_id: fk('mkt_orders', { allowNull: true }),
    source: str(20),
    progress_percent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    completed_lectures: count(),
    last_lecture_id: fk('mkt_lectures', { allowNull: true }),
    last_accessed_at: date(),
    completed_at: date(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_enrolments', ['user_id', 'course_id'], { unique: true });
  await qi.addIndex('mkt_enrolments', ['course_id']);

  await qi.createTable('mkt_lecture_progress', {
    id: id(),
    user_id: fk('users'),
    course_id: fk('mkt_courses'),
    lecture_id: fk('mkt_lectures'),
    position_seconds: count(),
    completed_at: date(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_lecture_progress', ['user_id', 'lecture_id'], { unique: true });
  await qi.addIndex('mkt_lecture_progress', ['user_id', 'course_id']);

  await qi.createTable('mkt_sale_ledger', {
    id: id(),
    entry_type: { ...str(20), defaultValue: 'sale' },
    order_id: fk('mkt_orders', { onDelete: 'RESTRICT' }),
    order_item_id: fk('mkt_order_items', { onDelete: 'RESTRICT' }),
    course_id: fk('mkt_courses', { onDelete: 'RESTRICT' }),
    seller_id: fk('mkt_sellers', { onDelete: 'RESTRICT' }),
    gross_paise: paise(),
    commission_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
    commission_paise: paise(),
    net_paise: paise(),
    // The payouts module (wave 2) sets it once the sale is paid out to the seller.
    payout_id: uint(),
    ...timestamps(),
  });
  await qi.addIndex('mkt_sale_ledger', ['order_item_id', 'entry_type'], { unique: true });
  await qi.addIndex('mkt_sale_ledger', ['seller_id', 'payout_id', 'created_at']);

  await qi.bulkInsert('mkt_settings', [
    { commission_percent: 30, instructor_signup_open: true, created_at: new Date(), updated_at: new Date() },
  ]);
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const t of [
    'mkt_sale_ledger',
    'mkt_lecture_progress',
    'mkt_enrolments',
    'mkt_webhook_events',
    'mkt_order_items',
    'mkt_orders',
    'mkt_coupons',
    'mkt_cart_items',
    'mkt_lectures',
    'mkt_sections',
    'mkt_courses',
    'mkt_categories',
  ])
    await qi.dropTable(t);
  await qi.removeConstraint('mkt_sellers', 'mkt_sellers_avatar_media_fk');
  await qi.dropTable('mkt_media');
  await qi.dropTable('mkt_sellers');
  await qi.dropTable('mkt_settings');
};
