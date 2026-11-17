/**
 * Website enquiry and demo-class forms feed the admissions enquiries pipeline: they create a
 * regular `enquiries` row (source `website`) through the admissions service, so counsellors see
 * them on the same board with the same follow-ups. No separate lead tables.
 */
import { z } from 'zod';
import type { DemoFormSettings, EnquiryFormSettings, PublicFormResult } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Forbidden } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { enquiryRepo } from '../admissions/admissions.service';
import { activeForm, validateCustomFields } from '../admissions/forms.service';
import { mobileSchema, resolveBranch } from '../students/students.service';
import { recordReferralConversion } from './referrals.service';
import { findPublicCourse } from './content.service';

const emptyToNull = (v: unknown) => (v === '' ? null : v);
const optNum = z.preprocess(emptyToNull, z.coerce.number().int().positive().nullable().optional());

export const publicLeadSchema = z.object({
  name: z.string().trim().min(2).max(150),
  mobile: mobileSchema,
  email: z.preprocess(emptyToNull, z.string().trim().toLowerCase().email().max(150).nullable().optional()),
  branchId: optNum,
  courseId: optNum,
  courseInterest: z.preprocess(emptyToNull, z.string().trim().max(150).nullable().optional()),
  message: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable().optional()),
  /** Demo forms: the chosen slot label, or a preferred date/time. */
  slot: z.preprocess(emptyToNull, z.string().trim().max(120).nullable().optional()),
  customFields: z.record(z.string(), z.unknown()).optional(),
  ref: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
  /** Honeypot: humans never fill it. */
  website: z.string().optional(),
});
export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

type FormBlock =
  | { id: string; type: 'enquiry_form'; settings: EnquiryFormSettings }
  | { id: string; type: 'demo_form'; settings: DemoFormSettings };

export async function submitLead(
  block: FormBlock,
  input: PublicLeadInput,
  pageSlug: string,
): Promise<PublicFormResult> {
  const { instituteId } = requireTenantContext();
  const successMessage =
    block.settings.successMessage ??
    (block.type === 'demo_form'
      ? 'Thanks! We have reserved your demo class and will call you to confirm.'
      : 'Thanks! Our counsellor will contact you shortly.');
  if (input.website) return { ok: true, enquiryId: 0, message: successMessage };
  if (!(await isModuleEnabled(instituteId, 'admissions')))
    throw Forbidden('Online enquiries are not available right now', 'ENQUIRIES_DISABLED');

  const branch = await resolveBranch(block.settings.branchId ?? input.branchId ?? null);
  const form = block.type === 'enquiry_form' ? await activeForm('enquiry', branch.id) : null;
  const customFields = form ? validateCustomFields(form.fields, input.customFields) : null;

  let courseId: number | null = null;
  let courseInterest = input.courseInterest ?? null;
  const wantedCourse =
    (block.type === 'demo_form' ? block.settings.courseId : null) ?? input.courseId ?? null;
  if (wantedCourse) {
    const course = await findPublicCourse(wantedCourse);
    if (!course) throw BadRequest('Unknown course');
    courseId = course.id;
    courseInterest ??= course.name;
  }

  const notes: string[] = [];
  if (block.type === 'demo_form') {
    const slots = block.settings.slots;
    if (slots.length && (!input.slot || !slots.some((s) => s.label === input.slot)))
      throw BadRequest('Pick one of the available demo sessions');
    notes.push(`[Demo class] ${input.slot ?? 'Preferred time not specified'}`);
  }
  if (input.message) notes.push(input.message);
  notes.push(
    `Submitted on the website (page "${pageSlug}")${input.ref ? `, referral code ${input.ref.toUpperCase()}` : ''}.`,
  );

  const enquiry = await enquiryRepo.create({
    branchId: branch.id,
    name: input.name,
    mobile: input.mobile,
    email: input.email ?? null,
    source: 'website',
    counsellorUserId: null,
    courseInterest,
    courseId,
    notes: notes.join('\n'),
    customFields,
    createdByUserId: null,
  });
  await audit({
    action: block.type === 'demo_form' ? 'website.demo_registered' : 'website.enquiry_submitted',
    entityType: 'enquiry',
    entityId: enquiry.id,
    metadata: { page: pageSlug, block: block.id, referral: input.ref ?? null },
  });
  await recordReferralConversion({
    code: input.ref,
    kind: 'signup',
    refType: block.type === 'demo_form' ? 'demo' : 'enquiry',
    refId: enquiry.id,
  });
  return { ok: true, enquiryId: enquiry.id, message: successMessage };
}
