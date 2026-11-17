import { Op } from 'sequelize';
import type { ParentChildDto, ParentPortalSectionDto } from '@erp/shared';
import { requireTenantContext } from '../../shared/context';
import { registerParentPortalProvider } from '../parent-portal/api';
import { FeeAccount, FeeInstalment, FeePayment } from './models';
import { today } from './util';

const KEY = 'fees';
const LABEL = 'Fees';
const PAID = ['successful', 'partially_refunded', 'refunded'];

const money = (n: number) =>
  `₹${(Math.round(n * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function openInstalments(child: ParentChildDto) {
  const { instituteId } = requireTenantContext();
  const accounts = await FeeAccount.findAll({
    where: { instituteId, studentId: child.studentId, status: 'active' },
    attributes: ['id', 'title'],
  });
  if (!accounts.length) return { accounts, instalments: [] as FeeInstalment[] };
  const instalments = (
    await FeeInstalment.findAll({
      where: {
        instituteId,
        accountId: { [Op.in]: accounts.map((a) => a.id) },
        status: { [Op.in]: ['pending', 'partial'] },
      },
      order: [
        ['dueDate', 'ASC'],
        ['seq', 'ASC'],
      ],
    })
  ).filter((i) => i.balance > 0);
  return { accounts, instalments };
}

function paymentItem(p: FeePayment) {
  return {
    title: `Paid ${money(p.amount)}`,
    subtitle: p.status === 'successful' ? p.mode : p.status.replace('_', ' '),
    date: p.paidOn ?? p.createdAt.toISOString().slice(0, 10),
    link: '/my-fees',
  };
}

/** Fee dues (next instalment, overdue) and recent payments of a linked child. */
async function summary(child: ParentChildDto): Promise<ParentPortalSectionDto | null> {
  const { instituteId } = requireTenantContext();
  const { accounts, instalments } = await openInstalments(child);
  const payments = await FeePayment.findAll({
    where: { instituteId, studentId: child.studentId, status: { [Op.in]: PAID } },
    order: [['id', 'DESC']],
    limit: 3,
  });
  if (!accounts.length && !payments.length) return null;
  const now = today();
  const overdue = instalments.filter((i) => i.dueDate < now);
  const outstanding = instalments.reduce((s, i) => s + i.balance, 0);
  const overdueAmount = overdue.reduce((s, i) => s + i.balance, 0);
  const next = instalments.find((i) => i.dueDate >= now);
  const title = new Map(accounts.map((a) => [a.id, a.title]));
  return {
    key: KEY,
    label: LABEL,
    metrics: [
      { label: 'Outstanding', value: money(outstanding), tone: outstanding > 0 ? 'warning' : 'success' },
      {
        label: 'Overdue',
        value: money(overdueAmount),
        hint: overdue.length ? `${overdue.length} instalment${overdue.length > 1 ? 's' : ''}` : undefined,
        tone: overdueAmount > 0 ? 'danger' : 'default',
      },
      ...(next ? [{ label: 'Next due', value: money(next.balance), hint: next.dueDate }] : []),
    ],
    items: [
      ...instalments.slice(0, 3).map((i) => ({
        title: `${i.label} · ${money(i.balance)}`,
        subtitle: [title.get(i.accountId), i.dueDate < now ? 'Overdue' : null].filter(Boolean).join(' · '),
        date: i.dueDate,
        link: '/my-fees',
      })),
      ...payments.map(paymentItem),
    ],
  };
}

/** Payments received in the month and dues still open at the end of it. */
async function monthlyReport(
  child: ParentChildDto,
  { from, to }: { from: string; to: string },
): Promise<ParentPortalSectionDto | null> {
  const { instituteId } = requireTenantContext();
  const { instalments } = await openInstalments(child);
  const payments = await FeePayment.findAll({
    where: {
      instituteId,
      studentId: child.studentId,
      status: { [Op.in]: PAID },
      paidOn: { [Op.between]: [from, to] },
    },
    order: [['paidOn', 'ASC']],
  });
  const overdue = instalments.filter((i) => i.dueDate <= to);
  if (!payments.length && !overdue.length) return null;
  return {
    key: KEY,
    label: LABEL,
    metrics: [
      { label: 'Paid this month', value: money(payments.reduce((s, p) => s + p.amount, 0)) },
      {
        label: 'Due as of month end',
        value: money(overdue.reduce((s, i) => s + i.balance, 0)),
        tone: overdue.length ? 'warning' : 'default',
      },
    ],
    items: payments.map(paymentItem),
  };
}

/** Registers the fees provider for the parent home and monthly report (called from `onReady`). */
export function registerFeesParentPortal(): void {
  registerParentPortalProvider({ key: KEY, label: LABEL, order: 30, summary, monthlyReport });
}
