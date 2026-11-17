import { z } from 'zod';
import { DEFAULT_STUDENT_SETTINGS, type StudentSettings } from '@erp/shared';
import { getSetting, setSetting } from '../institutes/settings.service';

export const SETTINGS_KEY = 'students.settings';

const SEQ_TOKEN = /\{SEQ(?::(\d{1,2}))?\}/g;
const ALLOWED_TOKENS = /\{(YYYY|YY|MM|INST|BRANCH|SEQ(?::\d{1,2})?)\}/g;

const numberFormat = z
  .string()
  .trim()
  .min(5)
  .max(80)
  .refine((v) => (v.match(SEQ_TOKEN) ?? []).length === 1, 'Format must contain exactly one {SEQ} or {SEQ:n}')
  .refine((v) => !/[{}]/.test(v.replace(ALLOWED_TOKENS, '')), 'Unknown token in format')
  .refine((v) => /^[A-Za-z0-9{}:/\-_. ]+$/.test(v), 'Format contains invalid characters');

export const studentSettingsSchema = z.object({
  admissionNumberFormat: numberFormat,
  rollNumberFormat: numberFormat,
  autoRollNumber: z.boolean(),
  maxGuardiansPerStudent: z.number().int().min(1).max(10),
  selfRegistrationEnabled: z.boolean(),
  defaultBranchId: z.number().int().positive().nullable(),
  enquirySources: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9_]{2,40}$/),
    )
    .min(1)
    .max(50),
  followUpReminderMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
});

/** Effective student/admission settings for the current institute (defaults + saved overrides). */
export async function getStudentSettings(): Promise<StudentSettings> {
  const saved = await getSetting<Partial<StudentSettings>>(SETTINGS_KEY, {});
  return { ...DEFAULT_STUDENT_SETTINGS, ...saved };
}

export async function saveStudentSettings(patch: Partial<StudentSettings>): Promise<StudentSettings> {
  const merged = studentSettingsSchema.parse({ ...(await getStudentSettings()), ...patch });
  await setSetting(SETTINGS_KEY, merged);
  return merged;
}
