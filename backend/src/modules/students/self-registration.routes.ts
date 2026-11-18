import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { SelfRegistrationInfo, SelfRegistrationResult } from '@erp/shared';
import { parse } from '../../shared/utilities/validation';
import { publicFormRateLimit } from '../../shared/middleware/security';
import { getContext, runWithContext } from '../../shared/context';
import { logger } from '../../infrastructure/logger';
import { audit } from '../../shared/audit/audit.service';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../shared/errors';
import { Institute } from '../institutes/institute.model';
import { isModuleEnabled } from '../subscriptions/subscription.service';
import { Branch } from '../branches/branch.model';
import { User } from '../users/user.model';
import { activeForm, validateCustomFields } from '../admissions/forms.service';
import { guardianInputSchema, linkGuardian } from '../guardians/guardians.service';
import { recordReferralConversion } from '../website/api';
import { Student } from './models';
import { getStudentSettings } from './settings';
import { createStudent, resolveBranch, studentFieldsSchema } from './students.service';

const emptyToNull = (v: unknown) => (v === '' ? null : v);

const registerBody = studentFieldsSchema
  .pick({
    name: true,
    mobile: true,
    email: true,
    branchId: true,
    dateOfBirth: true,
    gender: true,
    academicInfo: true,
  })
  .extend({
    password: z.string().min(8).max(200).optional(),
    parent: guardianInputSchema
      .pick({ name: true, mobile: true, email: true, relation: true })
      .nullable()
      .optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
    ref: z.preprocess(emptyToNull, z.string().trim().max(40).nullable().optional()),
    courseId: z.preprocess(emptyToNull, z.coerce.number().int().positive().nullable().optional()),
  });

const firstQuery = (req: Request, key: string) => {
  const v = req.query[key];
  return typeof v === 'string' ? v : undefined;
};

/**
 * Website attribution after a successful registration: counts a referral `signup` and records the
 * course the student came for. Best-effort — it never fails the registration.
 */
async function recordAttribution(
  instituteId: number,
  studentId: number,
  ref: string | null | undefined,
  courseId: number | null | undefined,
) {
  if (!ref && !courseId) return;
  try {
    let referral = false;
    if (ref && (await isModuleEnabled(instituteId, 'website')))
      referral = await recordReferralConversion({
        code: ref,
        kind: 'signup',
        refType: 'student',
        refId: studentId,
      });
    await audit({
      action: 'student.self_registration_attribution',
      entityType: 'student',
      entityId: studentId,
      metadata: {
        referralCode: ref ? ref.toUpperCase() : null,
        referralCounted: referral,
        courseId: courseId ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, studentId }, 'Recording self-registration attribution failed');
  }
}

async function activeInstitute(slug: string) {
  const inst = await Institute.findOne({ where: { slug: slug.toLowerCase(), status: 'active' } });
  if (!inst || !(await isModuleEnabled(inst.id, 'students'))) throw NotFound('Institute');
  return inst;
}

/**
 * Public routes have no authenticated tenant. We bind the context to the institute resolved from
 * the slug and mark it `system` so tenant-scoped services (numbering, settings, audit) run for
 * that institute only. Nothing here accepts an institute id from the client.
 */
function asInstitute<T>(instituteId: number, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ ...getContext(), system: true, instituteId, allowedBranchIds: null }, fn);
}

export function selfRegistrationRoutes(api: Router) {
  api.get('/public/institutes/:slug/registration', async (req, res) => {
    const inst = await activeInstitute(String(req.params.slug));
    const info = await asInstitute(inst.id, async (): Promise<SelfRegistrationInfo> => {
      const settings = await getStudentSettings();
      const branches = await Branch.findAll({
        where: { instituteId: inst.id, status: 'active' },
        attributes: ['id', 'name'],
        order: [['name', 'ASC']],
      });
      const form = await activeForm('self_registration');
      return {
        institute: { name: inst.name, slug: inst.slug },
        enabled: settings.selfRegistrationEnabled,
        branches: branches.map((b) => ({ id: b.id, name: b.name })),
        fields: form?.fields ?? [],
      };
    });
    res.json(info);
  });

  api.post('/public/institutes/:slug/register', publicFormRateLimit, async (req, res) => {
    const inst = await activeInstitute(String(req.params.slug));
    // `ref`/`courseId` may also arrive on the query string (links shared as `?ref=…&courseId=…`).
    const body = parse(registerBody, {
      ...req.body,
      ref: req.body?.ref ?? firstQuery(req, 'ref'),
      courseId: req.body?.courseId ?? firstQuery(req, 'courseId'),
    });
    const result = await asInstitute(inst.id, async (): Promise<SelfRegistrationResult> => {
      const settings = await getStudentSettings();
      if (!settings.selfRegistrationEnabled)
        throw Forbidden('Online registration is closed for this institute', 'SELF_REGISTRATION_DISABLED');
      const { ref: _ref, courseId: _courseId, ...studentInput } = body;
      const branch = await resolveBranch(body.branchId);
      const form = await activeForm('self_registration', branch.id);
      const customFields = form ? validateCustomFields(form.fields, body.customFields) : null;
      if (body.parent && body.parent.mobile === body.mobile)
        throw BadRequest('Parent mobile must be different from the student mobile');

      // Existing account (e.g. a parent or a student of another institute): only its owner may
      // attach it, so the password must match. Otherwise anyone could claim someone's mobile.
      let userId: number | null = null;
      const existing = await User.findOne({ where: { mobile: body.mobile } });
      if (existing) {
        const ok =
          !!body.password &&
          !!existing.passwordHash &&
          (await bcrypt.compare(body.password, existing.passwordHash));
        if (!ok)
          throw Conflict(
            'An account with this mobile number already exists. Enter its password to continue, or sign in.',
            'ACCOUNT_EXISTS',
          );
        if (await Student.count({ where: { instituteId: inst.id, userId: existing.id } }))
          throw Conflict(
            'You are already registered with this institute. Please sign in.',
            'ALREADY_REGISTERED',
          );
        userId = existing.id;
      }

      const student = await createStudent(
        { ...studentInput, branchId: branch.id, customFields },
        {
          source: 'self_registration',
          password: body.password,
          userId,
          afterCreate: async (s, transaction) => {
            if (!body.parent) return;
            // A brand-new parent account is linked straight away; an existing account is linked
            // as `pending` until the institute verifies it (prevents claiming other people's kids).
            const parentExists = await User.count({ where: { mobile: body.parent.mobile }, transaction });
            await linkGuardian(s, body.parent, { status: parentExists ? 'pending' : 'active', transaction });
          },
        },
      );
      await recordAttribution(inst.id, student.id, body.ref, body.courseId);
      const user = student.userId ? await User.findByPk(student.userId) : null;
      return {
        studentId: student.id,
        admissionNumber: student.admissionNumber,
        rollNumber: student.rollNumber ?? null,
        status: student.status,
        hasPassword: !!user?.passwordHash,
      };
    });
    res.status(201).json(result);
  });
}
