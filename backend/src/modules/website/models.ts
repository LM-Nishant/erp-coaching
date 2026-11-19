import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  CouponDiscountType,
  ReferralEventKind,
  WebsiteBlock,
  WebsiteSeo,
  WebsiteTheme,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = false) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const bool = (defaultValue: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const stamps = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

export class WebsiteSite extends Model<InferAttributes<WebsiteSite>, InferCreationAttributes<WebsiteSite>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare subdomain: string | null;
  declare customDomain: string | null;
  /** TXT token proving ownership of `customDomain`; regenerated whenever the domain changes. */
  declare domainToken: CreationOptional<string | null>;
  /** The custom domain once its TXT record was verified (unique); only this domain is served. */
  declare verifiedDomain: CreationOptional<string | null>;
  declare domainVerifiedAt: CreationOptional<Date | null>;
  declare theme: WebsiteTheme | null;
  declare seo: WebsiteSeo | null;
  declare indexable: CreationOptional<boolean>;
  declare appUrl: string | null;
  declare defaultBranchId: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class WebsitePage extends Model<InferAttributes<WebsitePage>, InferCreationAttributes<WebsitePage>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare slug: string;
  declare title: string;
  declare isHome: CreationOptional<boolean>;
  declare showInNav: CreationOptional<boolean>;
  declare sortOrder: CreationOptional<number>;
  declare blocks: WebsiteBlock[];
  declare seo: WebsiteSeo | null;
  declare publishedVersionId: CreationOptional<number | null>;
  declare hasDraftChanges: CreationOptional<boolean>;
  declare publishedVersion?: NonAttribute<WebsitePageVersion | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class WebsitePageVersion extends Model<
  InferAttributes<WebsitePageVersion>,
  InferCreationAttributes<WebsitePageVersion>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare pageId: number;
  declare version: number;
  declare title: string;
  declare blocks: WebsiteBlock[];
  declare seo: WebsiteSeo | null;
  declare mediaFileIds: number[];
  declare publishedByUserId: number | null;
  declare publishedAt: Date;
  declare publishedBy?: NonAttribute<User | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class WebsiteAnnouncement extends Model<
  InferAttributes<WebsiteAnnouncement>,
  InferCreationAttributes<WebsiteAnnouncement>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare title: string;
  declare body: string | null;
  declare linkUrl: string | null;
  declare startsAt: Date | null;
  declare endsAt: Date | null;
  declare isPinned: CreationOptional<boolean>;
  declare isPublished: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Coupon extends Model<InferAttributes<Coupon>, InferCreationAttributes<Coupon>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare code: string;
  declare description: string | null;
  declare discountType: CouponDiscountType;
  /** DECIMAL: MySQL returns a string. */
  declare discountValue: number | string;
  declare maxDiscount: number | string | null;
  declare minAmount: number | string | null;
  declare validFrom: Date | null;
  declare validUntil: Date | null;
  declare usageLimit: number | null;
  declare perCustomerLimit: number | null;
  declare usedCount: CreationOptional<number>;
  declare courseIds: number[] | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class CouponRedemption extends Model<
  InferAttributes<CouponRedemption>,
  InferCreationAttributes<CouponRedemption>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare couponId: number;
  declare orderRef: string;
  declare customerKey: string | null;
  declare amountPaise: number;
  declare discountPaise: number;
  declare status: CreationOptional<'redeemed' | 'released'>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ReferralCode extends Model<
  InferAttributes<ReferralCode>,
  InferCreationAttributes<ReferralCode>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare code: string;
  declare name: string;
  declare referrerUserId: number | null;
  declare commissionNote: string | null;
  declare isActive: CreationOptional<boolean>;
  declare clicks: CreationOptional<number>;
  declare signups: CreationOptional<number>;
  declare purchases: CreationOptional<number>;
  declare referrer?: NonAttribute<User | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ReferralEvent extends Model<
  InferAttributes<ReferralEvent>,
  InferCreationAttributes<ReferralEvent>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare referralCodeId: number;
  declare kind: ReferralEventKind;
  declare refType: string | null;
  declare refId: string | null;
  declare visitorHash: string | null;
  declare amountPaise: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initWebsiteModels(sequelize: Sequelize) {
  WebsiteSite.init(
    {
      id: pk,
      instituteId: uint(),
      subdomain: DataTypes.STRING(63),
      customDomain: DataTypes.STRING(253),
      domainToken: DataTypes.STRING(64),
      verifiedDomain: DataTypes.STRING(253),
      domainVerifiedAt: DataTypes.DATE,
      theme: DataTypes.JSON,
      seo: DataTypes.JSON,
      indexable: bool(true),
      appUrl: DataTypes.STRING(255),
      defaultBranchId: uint(true),
      ...stamps,
    },
    { sequelize, tableName: 'website_sites' },
  );
  WebsitePage.init(
    {
      id: pk,
      instituteId: uint(),
      slug: { type: DataTypes.STRING(80), allowNull: false },
      title: { type: DataTypes.STRING(150), allowNull: false },
      isHome: bool(false),
      showInNav: bool(true),
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      blocks: { type: DataTypes.JSON, allowNull: false },
      seo: DataTypes.JSON,
      publishedVersionId: uint(true),
      hasDraftChanges: bool(true),
      ...stamps,
    },
    { sequelize, tableName: 'website_pages' },
  );
  WebsitePageVersion.init(
    {
      id: pk,
      instituteId: uint(),
      pageId: uint(),
      version: uint(),
      title: { type: DataTypes.STRING(150), allowNull: false },
      blocks: { type: DataTypes.JSON, allowNull: false },
      seo: DataTypes.JSON,
      mediaFileIds: { type: DataTypes.JSON, allowNull: false },
      publishedByUserId: uint(true),
      publishedAt: { type: DataTypes.DATE, allowNull: false },
      ...stamps,
    },
    { sequelize, tableName: 'website_page_versions' },
  );
  WebsiteAnnouncement.init(
    {
      id: pk,
      instituteId: uint(),
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: DataTypes.TEXT,
      linkUrl: DataTypes.STRING(500),
      startsAt: DataTypes.DATE,
      endsAt: DataTypes.DATE,
      isPinned: bool(false),
      isPublished: bool(true),
      ...stamps,
    },
    { sequelize, tableName: 'website_announcements' },
  );
  Coupon.init(
    {
      id: pk,
      instituteId: uint(),
      code: { type: DataTypes.STRING(40), allowNull: false },
      description: DataTypes.STRING(255),
      discountType: { type: DataTypes.STRING(10), allowNull: false },
      discountValue: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      maxDiscount: DataTypes.DECIMAL(12, 2),
      minAmount: DataTypes.DECIMAL(12, 2),
      validFrom: DataTypes.DATE,
      validUntil: DataTypes.DATE,
      usageLimit: uint(true),
      perCustomerLimit: uint(true),
      usedCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      courseIds: DataTypes.JSON,
      isActive: bool(true),
      ...stamps,
    },
    { sequelize, tableName: 'website_coupons' },
  );
  CouponRedemption.init(
    {
      id: pk,
      instituteId: uint(),
      couponId: uint(),
      orderRef: { type: DataTypes.STRING(100), allowNull: false },
      customerKey: DataTypes.STRING(150),
      amountPaise: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      discountPaise: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'redeemed' },
      ...stamps,
    },
    { sequelize, tableName: 'website_coupon_redemptions' },
  );
  ReferralCode.init(
    {
      id: pk,
      instituteId: uint(),
      code: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(150), allowNull: false },
      referrerUserId: uint(true),
      commissionNote: DataTypes.STRING(255),
      isActive: bool(true),
      clicks: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      signups: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      purchases: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      ...stamps,
    },
    { sequelize, tableName: 'website_referral_codes' },
  );
  ReferralEvent.init(
    {
      id: pk,
      instituteId: uint(),
      referralCodeId: uint(),
      kind: { type: DataTypes.STRING(12), allowNull: false },
      refType: DataTypes.STRING(40),
      refId: DataTypes.STRING(100),
      visitorHash: DataTypes.STRING(64),
      amountPaise: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
      ...stamps,
    },
    { sequelize, tableName: 'website_referral_events' },
  );
  for (const m of [
    WebsiteSite,
    WebsitePage,
    WebsitePageVersion,
    WebsiteAnnouncement,
    Coupon,
    CouponRedemption,
    ReferralCode,
    ReferralEvent,
  ])
    registerTenantModel(m as never);
}

export function associateWebsiteModels() {
  WebsitePage.belongsTo(WebsitePageVersion, { foreignKey: 'publishedVersionId', as: 'publishedVersion' });
  WebsitePageVersion.belongsTo(User, { foreignKey: 'publishedByUserId', as: 'publishedBy' });
  ReferralCode.belongsTo(User, { foreignKey: 'referrerUserId', as: 'referrer' });
}
