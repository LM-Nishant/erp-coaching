import { Op } from 'sequelize';
import { z } from 'zod';
import {
  FORM_FIELD_TYPES,
  type AdmissionFormDto,
  type AdmissionFormPurpose,
  type FormFieldDef,
} from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { AppError } from '../../shared/errors';
import { AdmissionForm } from './models';

export const formFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use snake_case keys'),
    label: z.string().trim().min(1).max(100),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    helpText: z.string().trim().max(200).optional(),
  })
  .refine((f) => f.type !== 'select' || (f.options?.length ?? 0) > 0, 'Select fields need options');

export const formBodySchema = z.object({
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().max(2000).nullable().optional(),
  purpose: z.enum(['enquiry', 'admission', 'self_registration']),
  branchId: z.number().int().positive().nullable().optional(),
  fields: z
    .array(formFieldSchema)
    .max(50)
    .refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, 'Field keys must be unique'),
  isActive: z.boolean().optional(),
});

export function toFormDto(f: AdmissionForm): AdmissionFormDto {
  return {
    id: f.id,
    branchId: f.branchId,
    name: f.name,
    description: f.description,
    purpose: f.purpose,
    fields: f.fields ?? [],
    isActive: f.isActive,
  };
}

/** Active form for a purpose: branch-specific one first, then institute-wide. */
export async function activeForm(purpose: AdmissionFormPurpose, branchId?: number | null) {
  const { instituteId } = requireTenantContext();
  const forms = await AdmissionForm.findAll({
    where: {
      instituteId,
      purpose,
      isActive: true,
      branchId: branchId ? { [Op.or]: [branchId, null] } : null,
    },
    order: [['id', 'DESC']],
  });
  return forms.find((f) => f.branchId === branchId) ?? forms.find((f) => f.branchId === null) ?? null;
}

const PHONE = /^\+?\d{10,15}$/;

/**
 * Validates submitted custom values against institute-defined fields. Unknown keys are dropped;
 * missing required fields and type mismatches raise 422 with per-field messages.
 */
export function validateCustomFields(
  fields: FormFieldDef[],
  values: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  const input = values ?? {};
  const out: Record<string, string | number | boolean | null> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = input[f.key];
    const empty = raw === undefined || raw === null || raw === '';
    if (empty) {
      if (f.required && f.type !== 'checkbox') errors[f.key] = `${f.label} is required`;
      else if (f.required && f.type === 'checkbox') errors[f.key] = `${f.label} must be accepted`;
      continue;
    }
    switch (f.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) errors[f.key] = `${f.label} must be a number`;
        else out[f.key] = n;
        break;
      }
      case 'checkbox':
        if (typeof raw !== 'boolean') errors[f.key] = `${f.label} must be true or false`;
        else if (f.required && !raw) errors[f.key] = `${f.label} must be accepted`;
        else out[f.key] = raw;
        break;
      default: {
        const s = String(raw).trim();
        if (s.length > 2000) errors[f.key] = `${f.label} is too long`;
        else if (f.type === 'email' && !z.string().email().safeParse(s).success)
          errors[f.key] = `${f.label} must be an email`;
        else if (f.type === 'phone' && !PHONE.test(s)) errors[f.key] = `${f.label} must be a phone number`;
        else if (f.type === 'date' && !z.string().date().safeParse(s).success)
          errors[f.key] = `${f.label} must be a date (YYYY-MM-DD)`;
        else if (f.type === 'select' && !(f.options ?? []).includes(s))
          errors[f.key] = `${f.label} must be one of the options`;
        else out[f.key] = s;
      }
    }
  }
  if (Object.keys(errors).length)
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'Please correct the highlighted fields',
      Object.entries(errors).map(([key, message]) => ({ path: `customFields.${key}`, message })),
    );
  return out;
}
