import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FeeReceiptDto } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { NotFound } from '../../shared/errors';
import { getInstituteTimezone, nowInZone } from '../../shared/timezone';
import { saveUploadedFile, signedUrlFor } from '../files/files.service';
import { FileObject } from '../files/file.model';
import { Institute } from '../institutes/institute.model';
import { Student } from '../students/models';
import { FeeAccount, FeePayment, FeeReceipt } from './models';
import { renderPdf, type PdfLine, type PdfText } from './pdf';
import { getFeeSettings } from './settings.service';
import { formatRupees } from './util';

export function receiptDto(r: FeeReceipt): FeeReceiptDto {
  return {
    id: r.id,
    number: r.number,
    invoiceNumber: r.invoiceNumber,
    paymentId: r.paymentId,
    accountId: r.accountId,
    studentId: r.studentId,
    amount: r.amount,
    taxableValue: r.taxableValue,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
    status: r.status,
    issuedAt: r.issuedAt.toISOString(),
  };
}

const inr = (p: number) => `Rs. ${formatRupees(p)}`;
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');

const MODE_LABEL: Record<string, string> = {
  online: 'Online',
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
};

export async function receiptPdfBuffer(r: FeeReceipt): Promise<Buffer> {
  const { instituteId } = r;
  const [institute, student, account, payment, settings, tz] = await Promise.all([
    Institute.findByPk(instituteId),
    Student.findOne({ where: { instituteId, id: r.studentId } }),
    FeeAccount.findOne({ where: { instituteId, id: r.accountId } }),
    FeePayment.findOne({ where: { instituteId, id: r.paymentId } }),
    getFeeSettings(),
    getInstituteTimezone(instituteId),
  ]);
  const t: PdfText[] = [];
  const l: PdfLine[] = [];
  const tax = r.invoiceNumber != null;
  t.push({ x: 50, y: 50, text: ascii(institute?.name ?? 'Institute'), size: 16, bold: true });
  if (tax && settings.gstin) t.push({ x: 50, y: 68, text: `GSTIN: ${settings.gstin}`, size: 9 });
  t.push({
    x: 545,
    y: 50,
    text: tax ? 'TAX INVOICE / RECEIPT' : 'FEE RECEIPT',
    size: 12,
    bold: true,
    align: 'right',
  });
  if (r.status === 'cancelled')
    t.push({ x: 545, y: 68, text: 'CANCELLED', size: 12, bold: true, align: 'right' });
  l.push({ x1: 50, y1: 80, x2: 545, y2: 80 });
  const info: [string, string][] = [
    ['Receipt no.', r.number],
    ...(tax ? ([['Invoice no.', r.invoiceNumber!]] as [string, string][]) : []),
    ['Date', nowInZone(tz, r.issuedAt).date],
    ['Student', student ? `${student.name} (${student.admissionNumber})` : '-'],
    ['Fee account', account?.title ?? '-'],
    ['Payment mode', MODE_LABEL[payment?.mode ?? ''] ?? payment?.mode ?? '-'],
    ['Reference', payment?.gatewayPaymentId ?? payment?.referenceNo ?? payment?.chequeNumber ?? '-'],
  ];
  let y = 105;
  for (const [k, v] of info) {
    t.push({ x: 50, y, text: k, bold: true }, { x: 200, y, text: ascii(v) });
    y += 16;
  }
  y += 10;
  l.push({ x1: 50, y1: y - 12, x2: 545, y2: y - 12 });
  const rows: [string, number][] = tax
    ? [
        [`Taxable value (SAC ${settings.sacCode})`, r.taxableValue],
        ...(r.igst ? ([['IGST', r.igst]] as [string, number][]) : []),
        ...(r.cgst ? ([['CGST', r.cgst]] as [string, number][]) : []),
        ...(r.sgst ? ([['SGST', r.sgst]] as [string, number][]) : []),
        ['Non-taxable fees', r.amount - r.taxableValue - r.cgst - r.sgst - r.igst],
      ]
    : [];
  for (const [k, v] of rows) {
    if (!v) continue;
    t.push({ x: 50, y, text: k }, { x: 545, y, text: inr(v), align: 'right' });
    y += 16;
  }
  l.push({ x1: 50, y1: y - 4, x2: 545, y2: y - 4 });
  y += 14;
  t.push(
    { x: 50, y, text: 'Amount received', size: 13, bold: true },
    { x: 545, y, text: inr(r.amount), size: 13, bold: true, align: 'right' },
  );
  if (account) {
    y += 24;
    t.push({
      x: 50,
      y,
      text: `Balance due on this account after all payments: ${inr(Math.max(0, account.balance))}`,
      size: 9,
    });
  }
  t.push({
    x: 50,
    y: 800,
    text: 'This is a computer-generated receipt and does not require a signature.',
    size: 8,
  });
  return renderPdf(t, l);
}

/** Stores the receipt PDF once and returns a short-lived signed URL. */
export async function receiptPdfUrl(r: FeeReceipt) {
  const { instituteId } = requireTenantContext();
  let file = r.pdfFileId ? await FileObject.findOne({ where: { instituteId, id: r.pdfFileId } }) : null;
  if (!file) {
    const buf = await receiptPdfBuffer(r);
    const tempPath = path.join(os.tmpdir(), `receipt-${crypto.randomUUID()}.pdf`);
    await fs.promises.writeFile(tempPath, buf);
    file = await saveUploadedFile({
      tempPath,
      originalName: `receipt-${r.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: buf.length,
      module: 'fees',
      branchId: r.branchId,
    });
    await r.update({ pdfFileId: file.id });
  }
  return signedUrlFor(file);
}

export async function findReceipt(id: number) {
  const { instituteId } = requireTenantContext();
  const r = await FeeReceipt.findOne({ where: { instituteId, id } });
  if (!r) throw NotFound('Receipt');
  return r;
}
