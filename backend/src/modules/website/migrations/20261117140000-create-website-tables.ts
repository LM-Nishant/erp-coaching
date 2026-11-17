import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

const json = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });

export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.createTable('website_sites', {
    id: id(),
    ...tenantColumns(),
    subdomain: { type: DataTypes.STRING(63), allowNull: true },
    custom_domain: { type: DataTypes.STRING(253), allowNull: true },
    theme: json(),
    seo: json(),
    indexable: bool(true),
    app_url: { type: DataTypes.STRING(255), allowNull: true },
    default_branch_id: fk('branches', { allowNull: true }),
    ...timestamps(),
  });
  await qi.addIndex('website_sites', ['institute_id'], { unique: true });
  await qi.addIndex('website_sites', ['subdomain'], { unique: true });
  await qi.addIndex('website_sites', ['custom_domain'], { unique: true });

  await qi.createTable('website_pages', {
    id: id(),
    ...tenantColumns(),
    slug: { type: DataTypes.STRING(80), allowNull: false },
    title: { type: DataTypes.STRING(150), allowNull: false },
    is_home: bool(false),
    show_in_nav: bool(true),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    blocks: json(false),
    seo: json(),
    published_version_id: uint(),
    has_draft_changes: bool(true),
    ...timestamps(),
  });
  await qi.addIndex('website_pages', ['institute_id', 'slug'], { unique: true });

  await qi.createTable('website_page_versions', {
    id: id(),
    ...tenantColumns(),
    page_id: fk('website_pages'),
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(150), allowNull: false },
    blocks: json(false),
    seo: json(),
    media_file_ids: json(false),
    published_by_user_id: fk('users', { allowNull: true }),
    published_at: { type: DataTypes.DATE, allowNull: false },
    ...timestamps(),
  });
  await qi.addIndex('website_page_versions', ['institute_id', 'page_id', 'version'], { unique: true });

  await qi.createTable('website_announcements', {
    id: id(),
    ...tenantColumns(),
    title: { type: DataTypes.STRING(200), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: true },
    link_url: { type: DataTypes.STRING(500), allowNull: true },
    starts_at: { type: DataTypes.DATE, allowNull: true },
    ends_at: { type: DataTypes.DATE, allowNull: true },
    is_pinned: bool(false),
    is_published: bool(true),
    ...timestamps(),
  });
  await qi.addIndex('website_announcements', ['institute_id', 'is_published', 'starts_at']);

  await qi.createTable('website_coupons', {
    id: id(),
    ...tenantColumns(),
    code: { type: DataTypes.STRING(40), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    discount_type: { type: DataTypes.STRING(10), allowNull: false },
    discount_value: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    max_discount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    min_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    valid_from: { type: DataTypes.DATE, allowNull: true },
    valid_until: { type: DataTypes.DATE, allowNull: true },
    usage_limit: uint(),
    per_customer_limit: uint(),
    used_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    course_ids: json(),
    is_active: bool(true),
    ...timestamps(),
  });
  await qi.addIndex('website_coupons', ['institute_id', 'code'], { unique: true });

  await qi.createTable('website_coupon_redemptions', {
    id: id(),
    ...tenantColumns(),
    coupon_id: fk('website_coupons'),
    order_ref: { type: DataTypes.STRING(100), allowNull: false },
    customer_key: { type: DataTypes.STRING(150), allowNull: true },
    amount_paise: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    discount_paise: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'redeemed' },
    ...timestamps(),
  });
  await qi.addIndex('website_coupon_redemptions', ['institute_id', 'coupon_id', 'order_ref'], {
    unique: true,
  });
  await qi.addIndex('website_coupon_redemptions', ['institute_id', 'coupon_id', 'customer_key']);

  await qi.createTable('website_referral_codes', {
    id: id(),
    ...tenantColumns(),
    code: { type: DataTypes.STRING(40), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    referrer_user_id: fk('users', { allowNull: true }),
    commission_note: { type: DataTypes.STRING(255), allowNull: true },
    is_active: bool(true),
    clicks: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    signups: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    purchases: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    ...timestamps(),
  });
  await qi.addIndex('website_referral_codes', ['institute_id', 'code'], { unique: true });

  await qi.createTable('website_referral_events', {
    id: id(),
    ...tenantColumns(),
    referral_code_id: fk('website_referral_codes'),
    kind: { type: DataTypes.STRING(12), allowNull: false },
    ref_type: { type: DataTypes.STRING(40), allowNull: true },
    ref_id: { type: DataTypes.STRING(100), allowNull: true },
    visitor_hash: { type: DataTypes.STRING(64), allowNull: true },
    amount_paise: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    ...timestamps(),
  });
  await qi.addIndex('website_referral_events', ['institute_id', 'referral_code_id', 'kind', 'created_at'], {
    name: 'website_referral_events_code_kind_created',
  });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  for (const t of [
    'website_referral_events',
    'website_referral_codes',
    'website_coupon_redemptions',
    'website_coupons',
    'website_announcements',
    'website_page_versions',
    'website_pages',
    'website_sites',
  ])
    await qi.dropTable(t);
};
