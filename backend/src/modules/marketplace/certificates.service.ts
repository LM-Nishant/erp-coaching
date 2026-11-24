import crypto from 'node:crypto';
import { UniqueConstraintError } from 'sequelize';
import { mktCertificateVerifyPath, type MktCertificateDto, type MktCertificateVerifyDto } from '@erp/shared';
import { config } from '../../infrastructure/config';
import { getContext } from '../../shared/context';
import { NotFound } from '../../shared/errors';
import { audit } from '../../shared/audit/audit.service';
import { User } from '../users/user.model';
import { MktCourse, MktSeller, type MktEnrolment } from './models';
import { MktCertificate } from './quiz-models';
import { certificatePdf } from './certificate-pdf';
import { iso } from './util';

/** No 0/O/1/I so codes read back unambiguously. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newCertificateCode(): string {
  const bytes = crypto.randomBytes(10);
  return `MKT-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

async function toDto(c: MktCertificate): Promise<MktCertificateDto> {
  const course = await MktCourse.findByPk(c.courseId, { attributes: ['id', 'slug', 'status'] });
  return {
    code: c.code,
    learnerName: c.learnerName,
    courseTitle: c.courseTitle,
    courseId: c.courseId,
    // Only link the landing page while the course is on sale.
    courseSlug: course?.status === 'published' ? course.slug : null,
    sellerName: c.sellerName,
    issuedAt: iso(c.issuedAt)!,
    verifyPath: mktCertificateVerifyPath(c.code),
  };
}

/**
 * Issues the learner's certificate for a completed enrolment (idempotent: one per learner and course).
 * Names are snapshotted at issue time.
 */
export async function issueCertificate(e: MktEnrolment): Promise<MktCertificate> {
  const existing = await MktCertificate.findOne({ where: { userId: e.userId, courseId: e.courseId } });
  if (existing) return existing;
  const [user, course] = await Promise.all([
    User.findByPk(e.userId, { attributes: ['id', 'name'] }),
    MktCourse.findByPk(e.courseId, { include: [{ model: MktSeller, as: 'seller' }] }),
  ]);
  if (!user || !course) throw NotFound('Course');
  for (let i = 0; ; i++) {
    try {
      const cert = await MktCertificate.create({
        code: newCertificateCode(),
        userId: e.userId,
        courseId: e.courseId,
        learnerName: user.name,
        courseTitle: course.title,
        sellerName: course.seller?.displayName ?? '',
        issuedAt: e.completedAt ?? new Date(),
      });
      await audit({
        action: 'marketplace.certificate.issued',
        entityType: 'mkt_certificate',
        entityId: cert.id,
        instituteId: null,
        metadata: { courseId: e.courseId, code: cert.code },
      });
      return cert;
    } catch (err) {
      if (!(err instanceof UniqueConstraintError) || i >= 3) throw err;
      // Raced with another request for the same enrolment, or (very rarely) a code collision.
      const raced = await MktCertificate.findOne({ where: { userId: e.userId, courseId: e.courseId } });
      if (raced) return raced;
    }
  }
}

/** The learner's certificate codes by course id. */
export async function certificateCodes(userId: number, courseIds: number[]): Promise<Map<number, string>> {
  if (!courseIds.length) return new Map();
  const rows = await MktCertificate.findAll({
    where: { userId, courseId: courseIds },
    attributes: ['courseId', 'code'],
  });
  return new Map(rows.map((r) => [r.courseId, r.code]));
}

export async function myCertificates(): Promise<MktCertificateDto[]> {
  const rows = await MktCertificate.findAll({
    where: { userId: getContext().userId! },
    order: [['issuedAt', 'DESC']],
  });
  return Promise.all(rows.map(toDto));
}

async function byCode(code: string) {
  const c = await MktCertificate.findOne({ where: { code: code.toUpperCase() } });
  if (!c) throw NotFound('Certificate');
  return c;
}

export async function verifyCertificate(code: string): Promise<MktCertificateVerifyDto> {
  return { valid: true, certificate: await toDto(await byCode(code)) };
}

export async function certificatePdfFile(code: string): Promise<{ name: string; data: Buffer }> {
  const c = await byCode(code);
  const issuedOn = new Date(c.issuedAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  return {
    name: `certificate-${c.code}.pdf`,
    data: certificatePdf({
      code: c.code,
      learnerName: c.learnerName,
      courseTitle: c.courseTitle,
      sellerName: c.sellerName,
      issuedOn,
      verifyUrl: `${config.publicWebUrl}${mktCertificateVerifyPath(c.code)}`,
    }),
  };
}
