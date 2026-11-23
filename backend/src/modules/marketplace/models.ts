import {
  DataTypes,
  type InitOptions,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type ModelAttributes,
  type ModelStatic,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  MktCouponKind,
  MktCourseLevel,
  MktCourseStatus,
  MktLectureType,
  MktMediaKind,
  MktMediaStatus,
  MktOrderStatus,
  MktSellerStatus,
  MktSellerType,
} from '@erp/shared';

/**
 * Marketplace models are platform-wide (not tenant models): learners buy across institutes and
 * independent instructors belong to none. Access is checked in the services (seller ownership,
 * enrolment), and test/marketplace.test.ts covers it.
 */

type Attrs<M extends Model> = InferAttributes<M>;
type Create<M extends Model> = InferCreationAttributes<M>;

export class MktSettings extends Model<Attrs<MktSettings>, Create<MktSettings>> {
  declare id: CreationOptional<number>;
  declare commissionPercent: number;
  declare instructorSignupOpen: boolean;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktSeller extends Model<Attrs<MktSeller>, Create<MktSeller>> {
  declare id: CreationOptional<number>;
  declare type: MktSellerType;
  declare slug: string;
  declare displayName: string;
  declare headline: string | null;
  declare bio: string | null;
  declare website: string | null;
  declare avatarMediaId: number | null;
  declare ownerInstituteId: number | null;
  declare userId: number | null;
  declare status: CreationOptional<MktSellerStatus>;
  declare commissionPercent: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare avatar?: NonAttribute<MktMedia | null>;
}

export class MktMedia extends Model<Attrs<MktMedia>, Create<MktMedia>> {
  declare id: CreationOptional<number>;
  declare sellerId: number;
  declare uploadedByUserId: number | null;
  declare kind: MktMediaKind;
  declare originalName: string;
  declare mimeType: string;
  declare sizeBytes: number;
  declare receivedBytes: CreationOptional<number>;
  declare storageKey: string;
  declare status: CreationOptional<MktMediaStatus>;
  declare error: CreationOptional<string | null>;
  declare durationSeconds: CreationOptional<number | null>;
  declare hlsPrefix: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktCategory extends Model<Attrs<MktCategory>, Create<MktCategory>> {
  declare id: CreationOptional<number>;
  declare parentId: number | null;
  declare slug: string;
  declare name: string;
  declare icon: string | null;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktCourse extends Model<Attrs<MktCourse>, Create<MktCourse>> {
  declare id: CreationOptional<number>;
  declare sellerId: number;
  declare slug: string;
  declare title: string;
  declare subtitle: string | null;
  declare description: string | null;
  declare categoryId: number | null;
  declare subcategoryId: number | null;
  declare level: CreationOptional<MktCourseLevel>;
  declare language: CreationOptional<string>;
  declare pricePaise: CreationOptional<number>;
  declare outcomes: string[] | null;
  declare requirements: string[] | null;
  declare audience: string[] | null;
  declare thumbnailMediaId: number | null;
  declare promoMediaId: number | null;
  declare status: CreationOptional<MktCourseStatus>;
  declare reviewNote: CreationOptional<string | null>;
  declare submittedAt: CreationOptional<Date | null>;
  declare reviewedAt: CreationOptional<Date | null>;
  declare reviewedByUserId: CreationOptional<number | null>;
  declare publishedAt: CreationOptional<Date | null>;
  declare ratingAvg: CreationOptional<number>;
  declare ratingCount: CreationOptional<number>;
  declare enrolmentCount: CreationOptional<number>;
  declare lectureCount: CreationOptional<number>;
  declare durationSeconds: CreationOptional<number>;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare seller?: NonAttribute<MktSeller>;
  declare thumbnail?: NonAttribute<MktMedia | null>;
  declare promo?: NonAttribute<MktMedia | null>;
}

export class MktSection extends Model<Attrs<MktSection>, Create<MktSection>> {
  declare id: CreationOptional<number>;
  declare courseId: number;
  declare title: string;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktLecture extends Model<Attrs<MktLecture>, Create<MktLecture>> {
  declare id: CreationOptional<number>;
  declare courseId: number;
  declare sectionId: number;
  declare title: string;
  declare type: MktLectureType;
  declare description: string | null;
  declare articleBody: string | null;
  declare mediaId: number | null;
  declare preview: CreationOptional<boolean>;
  declare durationSeconds: CreationOptional<number>;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare media?: NonAttribute<MktMedia | null>;
}

export class MktCartItem extends Model<Attrs<MktCartItem>, Create<MktCartItem>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare courseId: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktCoupon extends Model<Attrs<MktCoupon>, Create<MktCoupon>> {
  declare id: CreationOptional<number>;
  declare sellerId: number | null;
  declare code: string;
  declare kind: MktCouponKind;
  declare value: number;
  declare courseIds: number[] | null;
  declare maxUses: number | null;
  declare usedCount: CreationOptional<number>;
  declare validFrom: Date | null;
  declare validUntil: Date | null;
  declare active: CreationOptional<boolean>;
  declare createdByUserId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktOrder extends Model<Attrs<MktOrder>, Create<MktOrder>> {
  declare id: CreationOptional<number>;
  declare number: string;
  declare userId: number;
  declare status: CreationOptional<MktOrderStatus>;
  declare subtotalPaise: number;
  declare discountPaise: number;
  declare totalPaise: number;
  declare couponId: number | null;
  declare couponCode: string | null;
  declare gateway: CreationOptional<string | null>;
  declare gatewayOrderId: CreationOptional<string | null>;
  declare gatewayPaymentId: CreationOptional<string | null>;
  declare checkoutPayload: CreationOptional<Record<string, unknown> | null>;
  declare idempotencyKey: string | null;
  declare buyerName: string;
  declare buyerMobile: string | null;
  declare buyerEmail: string | null;
  declare failureReason: CreationOptional<string | null>;
  declare paidAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare items?: NonAttribute<MktOrderItem[]>;
}

export class MktOrderItem extends Model<Attrs<MktOrderItem>, Create<MktOrderItem>> {
  declare id: CreationOptional<number>;
  declare orderId: number;
  declare courseId: number;
  declare sellerId: number;
  declare title: string;
  declare pricePaise: number;
  declare discountPaise: number;
  declare paidPaise: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktWebhookEvent extends Model<Attrs<MktWebhookEvent>, Create<MktWebhookEvent>> {
  declare id: CreationOptional<number>;
  declare gateway: string;
  declare eventKey: string;
  declare orderId: number | null;
  declare outcome: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktEnrolment extends Model<Attrs<MktEnrolment>, Create<MktEnrolment>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare courseId: number;
  declare orderId: number | null;
  declare source: 'purchase' | 'free' | 'grant';
  declare progressPercent: CreationOptional<number>;
  declare completedLectures: CreationOptional<number>;
  declare lastLectureId: CreationOptional<number | null>;
  declare lastAccessedAt: CreationOptional<Date | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare course?: NonAttribute<MktCourse>;
}

export class MktLectureProgress extends Model<Attrs<MktLectureProgress>, Create<MktLectureProgress>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare courseId: number;
  declare lectureId: number;
  declare positionSeconds: CreationOptional<number>;
  declare completedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MktSaleLedger extends Model<Attrs<MktSaleLedger>, Create<MktSaleLedger>> {
  declare id: CreationOptional<number>;
  declare entryType: CreationOptional<'sale' | 'refund'>;
  declare orderId: number;
  declare orderItemId: number;
  declare courseId: number;
  declare sellerId: number;
  declare grossPaise: number;
  declare commissionPercent: number;
  declare commissionPaise: number;
  declare netPaise: number;
  declare payoutId: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare seller?: NonAttribute<MktSeller>;
  declare course?: NonAttribute<MktCourse>;
  declare order?: NonAttribute<MktOrder>;
}

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const str = (len: number, allowNull = false) => ({ type: DataTypes.STRING(len), allowNull });
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const count = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const date = () => ({ type: DataTypes.DATE, allowNull: true });
const text = () => ({ type: DataTypes.TEXT, allowNull: true });
/** BIGINT/DECIMAL come back from mysql2 as strings; expose them as numbers. */
const num = (
  field: string,
  type: DataTypes.DataType,
  allowNull = false,
  defaultValue: number | null = 0,
) => ({
  type,
  allowNull,
  ...(defaultValue !== null ? { defaultValue } : {}),
  get(this: Model) {
    const v = this.getDataValue(field) as unknown;
    return v === null || v === undefined ? null : Number(v);
  },
});
const paise = (field: string) => num(field, DataTypes.BIGINT.UNSIGNED);
const pct = (field: string, allowNull = false) =>
  num(field, DataTypes.DECIMAL(5, 2), allowNull, allowNull ? null : 0);
const list = (field: string) => ({
  type: DataTypes.JSON,
  allowNull: true,
  get(this: Model) {
    const v = this.getDataValue(field) as unknown;
    // mysql2 may hand JSON columns back as strings.
    return typeof v === 'string' ? (JSON.parse(v) as unknown) : (v ?? null);
  },
});

function define<M extends Model>(
  model: ModelStatic<M>,
  sequelize: Sequelize,
  tableName: string,
  attrs: Record<string, unknown>,
) {
  (model as unknown as { init: (a: ModelAttributes, o: InitOptions) => void }).init(
    { id: pk, ...attrs, createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE } as ModelAttributes,
    { sequelize, tableName },
  );
}

export function initMarketplaceModels(sequelize: Sequelize) {
  define(MktSettings, sequelize, 'mkt_settings', {
    commissionPercent: pct('commissionPercent'),
    instructorSignupOpen: bool(true),
  });
  define(MktSeller, sequelize, 'mkt_sellers', {
    type: str(20),
    slug: str(120),
    displayName: str(150),
    headline: str(200, true),
    bio: text(),
    website: str(300, true),
    avatarMediaId: uint(),
    ownerInstituteId: uint(),
    userId: uint(),
    status: { ...str(20), defaultValue: 'active' },
    commissionPercent: pct('commissionPercent', true),
  });
  define(MktMedia, sequelize, 'mkt_media', {
    sellerId: uint(false),
    uploadedByUserId: uint(),
    kind: str(10),
    originalName: str(255),
    mimeType: str(150),
    sizeBytes: paise('sizeBytes'),
    receivedBytes: paise('receivedBytes'),
    storageKey: str(400),
    status: { ...str(20), defaultValue: 'uploading' },
    error: str(500, true),
    durationSeconds: uint(),
    hlsPrefix: str(300, true),
  });
  define(MktCategory, sequelize, 'mkt_categories', {
    parentId: uint(),
    slug: str(120),
    name: str(120),
    icon: str(60, true),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  define(MktCourse, sequelize, 'mkt_courses', {
    sellerId: uint(false),
    slug: str(160),
    title: str(160),
    subtitle: str(250, true),
    description: text(),
    categoryId: uint(),
    subcategoryId: uint(),
    level: { ...str(20), defaultValue: 'all' },
    language: { ...str(10), defaultValue: 'en' },
    pricePaise: paise('pricePaise'),
    outcomes: list('outcomes'),
    requirements: list('requirements'),
    audience: list('audience'),
    thumbnailMediaId: uint(),
    promoMediaId: uint(),
    status: { ...str(20), defaultValue: 'draft' },
    reviewNote: str(1000, true),
    submittedAt: date(),
    reviewedAt: date(),
    reviewedByUserId: uint(),
    publishedAt: date(),
    ratingAvg: num('ratingAvg', DataTypes.DECIMAL(3, 2)),
    ratingCount: count(),
    enrolmentCount: count(),
    lectureCount: count(),
    durationSeconds: count(),
    createdByUserId: uint(),
  });
  define(MktSection, sequelize, 'mkt_sections', {
    courseId: uint(false),
    title: str(200),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  define(MktLecture, sequelize, 'mkt_lectures', {
    courseId: uint(false),
    sectionId: uint(false),
    title: str(200),
    type: str(20),
    description: text(),
    articleBody: { type: DataTypes.TEXT('medium'), allowNull: true },
    mediaId: uint(),
    preview: bool(false),
    durationSeconds: count(),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  });
  define(MktCartItem, sequelize, 'mkt_cart_items', { userId: uint(false), courseId: uint(false) });
  define(MktCoupon, sequelize, 'mkt_coupons', {
    sellerId: uint(),
    code: str(40),
    kind: str(10),
    value: uint(false),
    courseIds: list('courseIds'),
    maxUses: uint(),
    usedCount: count(),
    validFrom: date(),
    validUntil: date(),
    active: bool(true),
    createdByUserId: uint(),
  });
  define(MktOrder, sequelize, 'mkt_orders', {
    number: str(30),
    userId: uint(false),
    status: { ...str(20), defaultValue: 'pending' },
    subtotalPaise: paise('subtotalPaise'),
    discountPaise: paise('discountPaise'),
    totalPaise: paise('totalPaise'),
    couponId: uint(),
    couponCode: str(40, true),
    gateway: str(20, true),
    gatewayOrderId: str(120, true),
    gatewayPaymentId: str(120, true),
    checkoutPayload: list('checkoutPayload'),
    idempotencyKey: str(160, true),
    buyerName: str(150),
    buyerMobile: str(20, true),
    buyerEmail: str(190, true),
    failureReason: str(300, true),
    paidAt: date(),
  });
  define(MktOrderItem, sequelize, 'mkt_order_items', {
    orderId: uint(false),
    courseId: uint(false),
    sellerId: uint(false),
    title: str(160),
    pricePaise: paise('pricePaise'),
    discountPaise: paise('discountPaise'),
    paidPaise: paise('paidPaise'),
  });
  define(MktWebhookEvent, sequelize, 'mkt_webhook_events', {
    gateway: str(20),
    eventKey: str(191),
    orderId: uint(),
    outcome: str(30),
  });
  define(MktEnrolment, sequelize, 'mkt_enrolments', {
    userId: uint(false),
    courseId: uint(false),
    orderId: uint(),
    source: str(20),
    progressPercent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    completedLectures: count(),
    lastLectureId: uint(),
    lastAccessedAt: date(),
    completedAt: date(),
  });
  define(MktLectureProgress, sequelize, 'mkt_lecture_progress', {
    userId: uint(false),
    courseId: uint(false),
    lectureId: uint(false),
    positionSeconds: count(),
    completedAt: date(),
  });
  define(MktSaleLedger, sequelize, 'mkt_sale_ledger', {
    entryType: { ...str(20), defaultValue: 'sale' },
    orderId: uint(false),
    orderItemId: uint(false),
    courseId: uint(false),
    sellerId: uint(false),
    grossPaise: paise('grossPaise'),
    commissionPercent: pct('commissionPercent'),
    commissionPaise: paise('commissionPaise'),
    netPaise: paise('netPaise'),
    payoutId: uint(),
  });
}

export function associateMarketplaceModels() {
  MktSeller.belongsTo(MktMedia, { as: 'avatar', foreignKey: 'avatarMediaId', constraints: false });
  MktCourse.belongsTo(MktSeller, { as: 'seller', foreignKey: 'sellerId' });
  MktCourse.belongsTo(MktMedia, { as: 'thumbnail', foreignKey: 'thumbnailMediaId', constraints: false });
  MktCourse.belongsTo(MktMedia, { as: 'promo', foreignKey: 'promoMediaId', constraints: false });
  MktLecture.belongsTo(MktMedia, { as: 'media', foreignKey: 'mediaId', constraints: false });
  MktOrder.hasMany(MktOrderItem, { as: 'items', foreignKey: 'orderId' });
  MktEnrolment.belongsTo(MktCourse, { as: 'course', foreignKey: 'courseId' });
  MktSaleLedger.belongsTo(MktSeller, { as: 'seller', foreignKey: 'sellerId' });
  MktSaleLedger.belongsTo(MktCourse, { as: 'course', foreignKey: 'courseId' });
  MktSaleLedger.belongsTo(MktOrder, { as: 'order', foreignKey: 'orderId' });
}
