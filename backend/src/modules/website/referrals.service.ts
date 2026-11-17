import { Op, type Transaction } from 'sequelize';
import { z } from 'zod';
import type { ReferralCodeDto, ReferralEventKind } from '@erp/shared';
import { sha256 } from '../../infrastructure/crypto';
import { requireTenantContext } from '../../shared/context';
import { Conflict } from '../../shared/errors';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { codeSchema } from './coupons.service';
import { ReferralCode, ReferralEvent } from './models';

export const referralRepo = new TenantRepository(ReferralCode, { entity: 'Referral code' });

export const referralInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(2).max(150),
  referrerUserId: z.number().int().positive().nullable().optional(),
  commissionNote: z.string().trim().max(255).nullable().optional(),
  isActive: z.boolean().optional(),
});

export function toReferralDto(r: ReferralCode, siteBase: string): ReferralCodeDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    referrerUserId: r.referrerUserId,
    referrerName: r.referrer?.name ?? null,
    commissionNote: r.commissionNote,
    isActive: r.isActive,
    clicks: r.clicks,
    signups: r.signups,
    purchases: r.purchases,
    shareUrl: `${siteBase}/r/${encodeURIComponent(r.code)}`,
  };
}

export async function assertReferralCodeFree(code: string, exceptId?: number) {
  const where: Record<string | symbol, unknown> = { code };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await referralRepo.count(where)) throw Conflict('A referral code with this code already exists');
}

const COUNTER: Record<ReferralEventKind, 'clicks' | 'signups' | 'purchases'> = {
  click: 'clicks',
  signup: 'signups',
  purchase: 'purchases',
};

/** Same visitor (ip + user agent) clicking again within this window counts once. */
const CLICK_DEDUPE_MS = 24 * 60 * 60 * 1000;

export function visitorHash(ip: string | undefined, userAgent: string | undefined) {
  return sha256(`${ip ?? ''}|${userAgent ?? ''}`).slice(0, 64);
}

/** Records a click on a referral link; returns whether it counted (unique per visitor per day). */
export async function recordReferralClick(code: string, hash: string): Promise<boolean> {
  const { instituteId } = requireTenantContext();
  const rc = await referralRepo.findOne({ where: { code: code.trim().toUpperCase(), isActive: true } });
  if (!rc) return false;
  const recent = await ReferralEvent.count({
    where: {
      instituteId,
      referralCodeId: rc.id,
      kind: 'click',
      visitorHash: hash,
      createdAt: { [Op.gte]: new Date(Date.now() - CLICK_DEDUPE_MS) },
    },
  });
  if (recent) return false;
  await ReferralEvent.create({
    instituteId,
    referralCodeId: rc.id,
    kind: 'click',
    refType: null,
    refId: null,
    visitorHash: hash,
    amountPaise: null,
  });
  await rc.increment('clicks');
  return true;
}

/**
 * Attributes a signup (enquiry, demo registration, self-registration) or a purchase to a referral
 * code of the current institute. Unknown or inactive codes are ignored. Idempotent per
 * (kind, refType, refId), so retries and duplicate webhooks don't double count.
 */
export async function recordReferralConversion(
  input: {
    code: string | null | undefined;
    kind: 'signup' | 'purchase';
    refType: string;
    refId: string | number;
    amountPaise?: number | null;
  },
  opts: { transaction?: Transaction } = {},
): Promise<boolean> {
  if (!input.code) return false;
  const { instituteId } = requireTenantContext();
  const rc = await referralRepo.findOne({
    where: { code: input.code.trim().toUpperCase(), isActive: true },
    transaction: opts.transaction,
  });
  if (!rc) return false;
  const refId = String(input.refId);
  const dup = await ReferralEvent.count({
    where: { instituteId, referralCodeId: rc.id, kind: input.kind, refType: input.refType, refId },
    transaction: opts.transaction,
  });
  if (dup) return false;
  await ReferralEvent.create(
    {
      instituteId,
      referralCodeId: rc.id,
      kind: input.kind,
      refType: input.refType,
      refId,
      visitorHash: null,
      amountPaise: input.amountPaise ?? null,
    },
    { transaction: opts.transaction },
  );
  await rc.increment(COUNTER[input.kind], { transaction: opts.transaction });
  return true;
}
