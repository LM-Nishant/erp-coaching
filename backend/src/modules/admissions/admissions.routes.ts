import { emitAdmissionCompleted } from './admission-events';
import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import { ENQUIRY_STATUSES, APPLICATION_STATUSES } from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requireModule, requirePermission, requireTenant } from '../../shared/middleware/authorize';
import { requireTenantContext } from '../../shared/context';
import { BadRequest, Conflict, NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import {
  createStudent,
  findDuplicates,
  mobileSchema,
  resolveBranch,
  studentFieldsSchema,
  toStudentDto,
} from '../students/students.service';
import { AdmissionApplication, AdmissionForm, Enquiry, EnquiryFollowUp } from './models';
import {
  addToWaitlist,
  applicationRepo,
  assertAdmissionBatch,
  notifyAdmissionConfirmed,
  assertInstituteMember,
  assertValidSource,
  completeAdmission,
  enquiryRepo,
  leaveWaitlist,
  moveInWaitlist,
  nextWaitlistPosition,
  refreshNextFollowUp,
  scheduleReminder,
  toApplicationDto,
  toEnquiryDto,
  toFollowUpDto,
} from './admissions.service';
import { activeForm, formBodySchema, toFormDto, validateCustomFields } from './forms.service';

const optStr = (max: number) => z.string().trim().max(max).nullable().optional();
const futureDate = z.coerce.date();

const enquiryBody = z.object({
  name: z.string().trim().min(2).max(150),
  mobile: mobileSchema,
  email: z.string().trim().toLowerCase().email().max(150).nullable().optional(),
  branchId: z.number().int().positive().optional(),
  source: z.string().trim().max(40).default('walk_in'),
  counsellorUserId: z.number().int().positive().nullable().optional(),
  courseInterest: optStr(150),
  courseId: z.number().int().positive().nullable().optional(),
  notes: optStr(5000),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
});
const enquiryPatch = enquiryBody
  .omit({ branchId: true })
  .partial()
  .extend({ status: z.enum(ENQUIRY_STATUSES).optional() });

const followUpBody = z.object({
  note: optStr(2000),
  outcome: optStr(40),
  scheduledAt: futureDate.nullable().optional(),
  completed: z.boolean().optional(),
});

const applicationBody = z.object({
  branchId: z.number().int().positive().optional(),
  enquiryId: z.number().int().positive().nullable().optional(),
  formId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(2).max(150),
  mobile: mobileSchema,
  email: z.string().trim().toLowerCase().email().max(150).nullable().optional(),
  courseId: z.number().int().positive().nullable().optional(),
  batchId: z.number().int().positive().nullable().optional(),
  formData: z.record(z.string(), z.unknown()).nullable().optional(),
  waitlist: z.boolean().optional(),
});

const followUpParams = z.object({
  id: z.coerce.number().int().positive(),
  followUpId: z.coerce.number().int().positive(),
});

const convertBody = studentFieldsSchema
  .omit({ name: true, mobile: true })
  .partial()
  .extend({ allowDuplicate: z.boolean().optional() });

async function loadFollowUps(enquiryId: number) {
  const { instituteId } = requireTenantContext();
  return EnquiryFollowUp.findAll({ where: { instituteId, enquiryId }, order: [['id', 'DESC']] });
}

async function findEnquiry(id: number) {
  return enquiryRepo.findById(id, {
    include: [{ model: User, as: 'counsellor', attributes: ['id', 'name'] }],
  });
}

/** Validates form data against the selected (or active) admission form. */
async function resolveFormData(
  formId: number | null | undefined,
  branchId: number,
  data: Record<string, unknown> | null | undefined,
) {
  const { instituteId } = requireTenantContext();
  const form = formId
    ? await AdmissionForm.findOne({ where: { instituteId, id: formId, purpose: 'admission' } })
    : await activeForm('admission', branchId);
  if (formId && !form) throw BadRequest('Unknown admission form');
  return { formId: form?.id ?? null, formData: form ? validateCustomFields(form.fields, data) : null };
}

export function admissionRoutes(api: Router) {
  const r = Router();
  r.use(authenticate, requireTenant, requireModule('admissions'));

  // ================================================================ enquiries
  r.get('/enquiries', requirePermission('admissions', 'view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(ENQUIRY_STATUSES).optional(),
        source: z.string().max(40).optional(),
        counsellorUserId: z.coerce.number().int().positive().optional(),
        mine: z.enum(['true', 'false']).optional(),
        followUpDue: z.enum(['true', 'false']).optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.source) where.source = q.source;
    if (q.counsellorUserId) where.counsellorUserId = q.counsellorUserId;
    if (q.mine === 'true') where.counsellorUserId = requireTenantContext().userId;
    if (q.followUpDue === 'true') where.nextFollowUpAt = { [Op.lte]: new Date() };
    if (q.search) {
      const like = `%${q.search}%`;
      where[Op.or] = [
        { name: { [Op.like]: like } },
        { mobile: { [Op.like]: like } },
        { email: { [Op.like]: like } },
      ];
    }
    const { rows, count } = await enquiryRepo.findAndCountAll({
      where: where as WhereOptions<Enquiry>,
      include: [{ model: User, as: 'counsellor', attributes: ['id', 'name'] }],
      order: [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toEnquiryDto), count, q));
  });

  /** Pipeline board: counts per status for the visible branches. */
  r.get('/enquiries/summary', requirePermission('admissions', 'view'), async (_req, res) => {
    const rows = (await Enquiry.findAll({
      where: enquiryRepo.scope(),
      attributes: ['status', [getSequelize().fn('COUNT', getSequelize().col('id')), 'count']],
      group: ['status'],
      raw: true,
    })) as unknown as { status: string; count: number }[];
    const summary = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const row of rows) summary[row.status] = Number(row.count);
    res.json(summary);
  });

  r.post('/enquiries', requirePermission('admissions', 'create'), async (req, res) => {
    const body = parse(enquiryBody, req.body);
    await assertValidSource(body.source);
    if (body.counsellorUserId) await assertInstituteMember(body.counsellorUserId);
    const branch = await resolveBranch(body.branchId);
    const form = await activeForm('enquiry', branch.id);
    const customFields = form ? validateCustomFields(form.fields, body.customFields) : null;
    const duplicates = await findDuplicates({ mobile: body.mobile, email: body.email });
    const enquiry = await enquiryRepo.create({
      branchId: branch.id,
      name: body.name,
      mobile: body.mobile,
      email: body.email ?? null,
      source: body.source,
      counsellorUserId: body.counsellorUserId ?? null,
      courseInterest: body.courseInterest ?? null,
      courseId: body.courseId ?? null,
      notes: body.notes ?? null,
      customFields,
      createdByUserId: requireTenantContext().userId ?? null,
    });
    await audit({ action: 'enquiry.created', entityType: 'enquiry', entityId: enquiry.id });
    // Duplicates are a warning for enquiries (the same person may enquire twice), not a block.
    res.status(201).json({ ...toEnquiryDto(enquiry), duplicates });
  });

  r.get('/enquiries/:id', requirePermission('admissions', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const enquiry = await findEnquiry(id);
    const followUps = await loadFollowUps(id);
    res.json({ ...toEnquiryDto(enquiry), followUps: followUps.map(toFollowUpDto) });
  });

  r.patch('/enquiries/:id', requirePermission('admissions', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(enquiryPatch, req.body);
    const enquiry = await findEnquiry(id);
    if (body.source) await assertValidSource(body.source);
    if (body.counsellorUserId) await assertInstituteMember(body.counsellorUserId);
    if (body.status === 'converted' && !enquiry.studentId)
      throw BadRequest('Use the convert action to admit the enquiry');
    const before = { status: enquiry.status, counsellorUserId: enquiry.counsellorUserId };
    const { customFields, ...rest } = body;
    const values: Partial<Enquiry> = { ...(rest as Partial<Enquiry>) };
    if (customFields !== undefined) {
      const form = await activeForm('enquiry', enquiry.branchId);
      values.customFields = form ? validateCustomFields(form.fields, customFields) : null;
    }
    await enquiry.update(values);
    if (body.counsellorUserId !== undefined && body.counsellorUserId !== before.counsellorUserId) {
      // Re-arm pending reminders for the new counsellor.
      const pending = await EnquiryFollowUp.findAll({
        where: { instituteId: enquiry.instituteId, enquiryId: id, completedAt: null, remindedAt: null },
      });
      for (const f of pending) if (f.scheduledAt && f.scheduledAt > new Date()) await scheduleReminder(f);
    }
    await audit({
      action: 'enquiry.updated',
      entityType: 'enquiry',
      entityId: id,
      metadata: { fields: Object.keys(body), before },
    });
    res.json(toEnquiryDto(await findEnquiry(id)));
  });

  r.delete('/enquiries/:id', requirePermission('admissions', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const enquiry = await enquiryRepo.findById(id);
    const { instituteId } = requireTenantContext();
    await getSequelize().transaction(async (transaction) => {
      await EnquiryFollowUp.destroy({ where: { instituteId, enquiryId: id }, transaction });
      await AdmissionApplication.update(
        { enquiryId: null },
        { where: { instituteId, enquiryId: id }, transaction },
      );
      await enquiry.destroy({ transaction });
    });
    await audit({
      action: 'enquiry.deleted',
      entityType: 'enquiry',
      entityId: id,
      metadata: { name: enquiry.name },
    });
    res.status(204).end();
  });

  r.post('/enquiries/:id/follow-ups', requirePermission('admissions', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(followUpBody, req.body);
    const enquiry = await enquiryRepo.findById(id);
    if (!body.note && !body.scheduledAt) throw BadRequest('Add a note or schedule a follow-up');
    const { userId } = requireTenantContext();
    const followUp = await EnquiryFollowUp.create({
      instituteId: enquiry.instituteId,
      enquiryId: id,
      note: body.note ?? null,
      outcome: body.outcome ?? null,
      scheduledAt: body.scheduledAt ?? null,
      completedAt: body.completed || !body.scheduledAt ? new Date() : null,
      createdByUserId: userId ?? null,
    });
    if (enquiry.status === 'new')
      await enquiry.update({ status: body.scheduledAt ? 'follow_up' : 'contacted' });
    await refreshNextFollowUp(enquiry);
    await scheduleReminder(followUp);
    res.status(201).json(toFollowUpDto(followUp));
  });

  r.patch(
    '/enquiries/:id/follow-ups/:followUpId',
    requirePermission('admissions', 'edit'),
    async (req, res) => {
      const { id, followUpId } = parse(followUpParams, req.params);
      const body = parse(followUpBody, req.body);
      const enquiry = await enquiryRepo.findById(id);
      const followUp = await EnquiryFollowUp.findOne({
        where: { instituteId: enquiry.instituteId, enquiryId: id, id: followUpId },
      });
      if (!followUp) throw NotFound('Follow-up');
      const rescheduled =
        body.scheduledAt !== undefined && body.scheduledAt?.getTime() !== followUp.scheduledAt?.getTime();
      await followUp.update({
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
        ...(rescheduled ? { scheduledAt: body.scheduledAt ?? null, remindedAt: null } : {}),
        ...(body.completed !== undefined ? { completedAt: body.completed ? new Date() : null } : {}),
      });
      await refreshNextFollowUp(enquiry);
      if (rescheduled || body.completed === false) await scheduleReminder(followUp);
      res.json(toFollowUpDto(followUp));
    },
  );

  r.post('/enquiries/:id/convert', requirePermission('students', 'create'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { allowDuplicate, ...extra } = parse(convertBody, req.body);
    const enquiry = await enquiryRepo.findById(id);
    if (enquiry.studentId) throw Conflict('Enquiry is already converted', 'ALREADY_CONVERTED');
    const student = await createStudent(
      {
        ...extra,
        name: enquiry.name,
        mobile: enquiry.mobile,
        email: extra.email ?? enquiry.email,
        branchId: extra.branchId ?? enquiry.branchId,
      },
      {
        source: 'enquiry',
        allowDuplicate,
        afterCreate: async (s, transaction) => {
          await enquiry.update(
            { status: 'converted', studentId: s.id, nextFollowUpAt: null },
            { transaction },
          );
        },
      },
    );
    await audit({
      action: 'enquiry.converted',
      entityType: 'enquiry',
      entityId: id,
      metadata: { studentId: student.id },
    });
    res.status(201).json(toStudentDto(student));
  });

  // ================================================================ admission forms
  r.get('/forms', requirePermission('admissions', 'view'), async (req, res) => {
    const q = parse(
      z.object({ purpose: z.enum(['enquiry', 'admission', 'self_registration']).optional() }),
      req.query,
    );
    const { instituteId } = requireTenantContext();
    const forms = await AdmissionForm.findAll({
      where: { instituteId, ...(q.purpose ? { purpose: q.purpose } : {}) },
      order: [['id', 'DESC']],
    });
    res.json(forms.map(toFormDto));
  });

  r.get('/forms/active', requirePermission('admissions', 'view'), async (req, res) => {
    const q = parse(
      z.object({
        purpose: z.enum(['enquiry', 'admission', 'self_registration']),
        branchId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const form = await activeForm(q.purpose, q.branchId);
    res.json(form ? toFormDto(form) : null);
  });

  async function findForm(id: number) {
    const { instituteId } = requireTenantContext();
    const form = await AdmissionForm.findOne({ where: { instituteId, id } });
    if (!form) throw NotFound('Form');
    return form;
  }

  async function assertFormBranch(branchId: number | null | undefined) {
    if (!branchId) return;
    const { allowedBranchIds } = requireTenantContext();
    if (allowedBranchIds !== null && !allowedBranchIds.includes(branchId)) throw NotFound('Branch');
    await resolveBranch(branchId);
  }

  r.post('/forms', requirePermission('admissions', 'configure'), async (req, res) => {
    const body = parse(formBodySchema, req.body);
    await assertFormBranch(body.branchId);
    const { instituteId } = requireTenantContext();
    const form = await AdmissionForm.create({
      instituteId,
      branchId: body.branchId ?? null,
      name: body.name,
      description: body.description ?? null,
      purpose: body.purpose,
      fields: body.fields,
      isActive: body.isActive ?? true,
    });
    await audit({ action: 'admission_form.created', entityType: 'admission_form', entityId: form.id });
    res.status(201).json(toFormDto(form));
  });

  r.get('/forms/:id', requirePermission('admissions', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(toFormDto(await findForm(id)));
  });

  r.put('/forms/:id', requirePermission('admissions', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(formBodySchema, req.body);
    await assertFormBranch(body.branchId);
    const form = await findForm(id);
    await form.update({
      name: body.name,
      description: body.description ?? null,
      purpose: body.purpose,
      branchId: body.branchId ?? null,
      fields: body.fields,
      isActive: body.isActive ?? form.isActive,
    });
    await audit({ action: 'admission_form.updated', entityType: 'admission_form', entityId: id });
    res.json(toFormDto(form));
  });

  r.delete('/forms/:id', requirePermission('admissions', 'configure'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const form = await findForm(id);
    const { instituteId } = requireTenantContext();
    if (await AdmissionApplication.count({ where: { instituteId, formId: id } })) {
      await form.update({ isActive: false }); // keep history of submitted applications
    } else await form.destroy();
    await audit({ action: 'admission_form.deleted', entityType: 'admission_form', entityId: id });
    res.status(204).end();
  });

  // ================================================================ applications & waitlist
  r.get('/applications', requirePermission('admissions', 'view'), async (req, res) => {
    const q = parse(
      paginationSchema.extend({
        status: z.enum(APPLICATION_STATUSES).optional(),
        courseId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const where: Record<string | symbol, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.courseId) where.courseId = q.courseId;
    if (q.search) {
      const like = `%${q.search}%`;
      where[Op.or] = [
        { name: { [Op.like]: like } },
        { mobile: { [Op.like]: like } },
        { email: { [Op.like]: like } },
      ];
    }
    const { rows, count } = await applicationRepo.findAndCountAll({
      where: where as WhereOptions<AdmissionApplication>,
      order:
        q.status === 'waitlisted'
          ? [
              ['courseId', 'ASC'],
              ['waitlistPosition', 'ASC'],
            ]
          : [['id', 'DESC']],
      ...toLimitOffset(q),
    });
    res.json(paginated(rows.map(toApplicationDto), count, q));
  });

  r.post('/applications', requirePermission('admissions', 'create'), async (req, res) => {
    const body = parse(applicationBody, req.body);
    let branchId = body.branchId;
    if (body.enquiryId) {
      const enquiry = await enquiryRepo.findById(body.enquiryId);
      branchId ??= enquiry.branchId;
    }
    const branch = await resolveBranch(branchId);
    const { formId, formData } = await resolveFormData(body.formId, branch.id, body.formData);
    const courseId = body.batchId
      ? await assertAdmissionBatch(body.batchId, branch.id, body.courseId)
      : (body.courseId ?? null);
    const duplicates = await findDuplicates({ mobile: body.mobile, email: body.email });
    const { instituteId } = requireTenantContext();
    const app = await getSequelize().transaction(async (transaction) => {
      const base = { instituteId, branchId: branch.id, courseId };
      return AdmissionApplication.create(
        {
          ...base,
          enquiryId: body.enquiryId ?? null,
          formId,
          name: body.name,
          mobile: body.mobile,
          email: body.email ?? null,
          batchId: body.batchId ?? null,
          formData,
          status: body.waitlist ? 'waitlisted' : 'pending',
          waitlistPosition: body.waitlist ? await nextWaitlistPosition(base, transaction) : null,
        },
        { transaction },
      );
    });
    await audit({ action: 'application.created', entityType: 'application', entityId: app.id });
    res.status(201).json({ ...toApplicationDto(app), duplicates });
  });

  r.get('/applications/:id', requirePermission('admissions', 'view'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(toApplicationDto(await applicationRepo.findById(id)));
  });

  const open = (a: AdmissionApplication) => {
    if (!['pending', 'waitlisted', 'approved'].includes(a.status))
      throw Conflict(`Application is already ${a.status}`, 'APPLICATION_CLOSED');
  };

  r.post('/applications/:id/waitlist', requirePermission('admissions', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const a = await applicationRepo.findById(id);
    open(a);
    if (a.status !== 'waitlisted') await addToWaitlist(a);
    await audit({
      action: 'application.waitlisted',
      entityType: 'application',
      entityId: id,
      metadata: { position: a.waitlistPosition },
    });
    res.json(toApplicationDto(a));
  });

  r.post('/applications/:id/move', requirePermission('admissions', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { position } = parse(z.object({ position: z.number().int().positive() }), req.body);
    const a = await applicationRepo.findById(id);
    await moveInWaitlist(a, position);
    res.json(toApplicationDto(await applicationRepo.findById(id)));
  });

  async function decide(id: number, status: 'approved' | 'rejected' | 'withdrawn', remarks?: string | null) {
    const a = await applicationRepo.findById(id);
    open(a);
    const { userId } = requireTenantContext();
    await getSequelize().transaction(async (transaction) => {
      await leaveWaitlist(a, transaction);
      await a.update(
        {
          status,
          remarks: remarks ?? a.remarks ?? null,
          decidedByUserId: userId ?? null,
          decidedAt: new Date(),
        },
        { transaction },
      );
    });
    await audit({
      action: `application.${status}`,
      entityType: 'application',
      entityId: id,
      metadata: { remarks },
    });
    return a;
  }

  const remarksBody = z.object({ remarks: z.string().trim().max(255).nullable().optional() });

  r.post('/applications/:id/approve', requirePermission('admissions', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { remarks } = parse(remarksBody, req.body ?? {});
    res.json(toApplicationDto(await decide(id, 'approved', remarks)));
  });

  r.post('/applications/:id/reject', requirePermission('admissions', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { remarks } = parse(remarksBody, req.body ?? {});
    res.json(toApplicationDto(await decide(id, 'rejected', remarks)));
  });

  r.post('/applications/:id/withdraw', requirePermission('admissions', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { remarks } = parse(remarksBody, req.body ?? {});
    res.json(toApplicationDto(await decide(id, 'withdrawn', remarks)));
  });

  r.post('/applications/:id/admit', requirePermission('admissions', 'approve'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    const { allowDuplicate, ...extra } = parse(convertBody, req.body ?? {});
    const a = await applicationRepo.findById(id);
    open(a);
    if (a.status === 'pending' && extra.branchId && extra.branchId !== a.branchId)
      throw BadRequest('Admit into the branch the application was made for');
    const student = await createStudent(
      { ...extra, name: a.name, mobile: a.mobile, email: extra.email ?? a.email, branchId: a.branchId },
      {
        source: 'application',
        allowDuplicate,
        afterCreate: (s, transaction) => completeAdmission(a, s, s.branchId, transaction),
      },
    );
    await audit({
      action: 'application.admitted',
      entityType: 'application',
      entityId: id,
      metadata: { studentId: student.id },
    });
    await notifyAdmissionConfirmed(a, student);
    await emitAdmissionCompleted({
      applicationId: a.id,
      studentId: student.id,
      studentUserId: student.userId ?? null,
      branchId: student.branchId,
      courseId: a.courseId ?? null,
      batchId: a.batchId ?? null,
    });
    res.status(201).json({ application: toApplicationDto(a), student: toStudentDto(student) });
  });

  api.use('/admissions', r);
}
