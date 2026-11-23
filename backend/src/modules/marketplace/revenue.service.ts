import { QueryTypes } from 'sequelize';
import type {
  MktCourseRevenueDto,
  MktRevenueDto,
  MktRevenueGroup,
  MktRevenuePoint,
  MktRevenueTotals,
  MktSellerBalance,
} from '@erp/shared';
import { getSequelize } from '../../infrastructure/database/sequelize';
import { BadRequest } from '../../shared/errors';
import { MktCourse } from './models';
import { MktPayoutAccount } from './payouts.models';
import { istDate, istDay, payoutSettings, settingsDto } from './payouts.service';
import { iso } from './util';

const DAY_MS = 86_400_000;
/** Ledger timestamps are UTC; reports group by the Indian calendar day. */
const IST = 'DATE_ADD(l.created_at, INTERVAL 330 MINUTE)';

const emptyTotals = (): MktRevenueTotals => ({
  grossPaise: 0,
  commissionPaise: 0,
  netPaise: 0,
  refundedPaise: 0,
  sales: 0,
  refunds: 0,
});

interface SumRow {
  k: string | number;
  entry_type: 'sale' | 'refund';
  n: number | string;
  g: string | number;
  c: string | number;
  net: string | number;
}

function add(t: MktRevenueTotals, r: SumRow) {
  const n = Number(r.n);
  const g = Number(r.g);
  const c = Number(r.c);
  const net = Number(r.net);
  if (r.entry_type === 'refund') {
    t.refunds += n;
    t.refundedPaise += g;
    t.grossPaise -= g;
    t.commissionPaise -= c;
    t.netPaise -= net;
  } else {
    t.sales += n;
    t.grossPaise += g;
    t.commissionPaise += c;
    t.netPaise += net;
  }
}

/** Every period between `from` and `to` so the chart has no gaps. */
function periods(from: string, to: string, groupBy: MktRevenueGroup): string[] {
  const out: string[] = [];
  if (groupBy === 'month') {
    let [y, m] = from.slice(0, 7).split('-').map(Number);
    const end = to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push(key);
      if (key >= end || out.length > 60) break;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  } else {
    for (let d = istDay(from); istDate(d) <= to && out.length <= 400; d = new Date(d.getTime() + DAY_MS))
      out.push(istDate(d));
  }
  return out;
}

export async function sellerBalance(sellerId: number): Promise<MktSellerBalance> {
  const settings = await payoutSettings();
  const holdCutoff = new Date(Date.now() - settings.holdDays * DAY_MS);
  const signed = `CASE WHEN l.entry_type = 'refund' THEN -CAST(l.net_paise AS SIGNED) ELSE CAST(l.net_paise AS SIGNED) END`;
  const [row] = await getSequelize().query<Record<string, string | number | Date | null>>(
    `SELECT
       COALESCE(SUM(CASE WHEN l.payout_id IS NULL THEN ${signed} END), 0) AS pending,
       -- Refunded sales are settled in the next run whatever their age, so they are never on hold.
       COALESCE(SUM(CASE WHEN l.payout_id IS NULL AND l.entry_type = 'sale' AND l.created_at >= :holdCutoff
                          AND NOT EXISTS (SELECT 1 FROM mkt_sale_ledger r
                                          WHERE r.order_item_id = l.order_item_id AND r.entry_type = 'refund')
                         THEN CAST(l.net_paise AS SIGNED) END), 0) AS on_hold,
       COALESCE(SUM(CASE WHEN p.status IN ('pending', 'held') THEN ${signed} END), 0) AS processing,
       COALESCE(SUM(CASE WHEN p.status = 'paid' THEN ${signed} END), 0) AS paid,
       (SELECT MAX(paid_at) FROM mkt_payouts WHERE seller_id = :sellerId AND status = 'paid') AS last_paid
     FROM mkt_sale_ledger l
     LEFT JOIN mkt_payouts p ON p.id = l.payout_id
     WHERE l.seller_id = :sellerId`,
    { type: QueryTypes.SELECT, replacements: { sellerId, holdCutoff } },
  );
  return {
    pendingPaise: Number(row?.pending ?? 0),
    onHoldPaise: Number(row?.on_hold ?? 0),
    processingPaise: Number(row?.processing ?? 0),
    paidPaise: Number(row?.paid ?? 0),
    lastPaidAt: row?.last_paid ? iso(new Date(row.last_paid as string))! : null,
  };
}

/**
 * Seller revenue for `from`–`to` (IST days, inclusive): totals and a series of gross, commission and
 * net earnings (refunds reversed), per-course sales and enrolments, and the all-time payout balance.
 */
export async function sellerRevenue(
  sellerId: number,
  q: { from?: string; to?: string; groupBy?: MktRevenueGroup },
): Promise<MktRevenueDto> {
  const groupBy = q.groupBy ?? 'month';
  const to = q.to ?? istDate(new Date());
  const [year, month] = to.split('-').map(Number);
  const from =
    q.from ??
    (groupBy === 'month'
      ? new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10)
      : istDate(new Date(istDay(to).getTime() - 29 * DAY_MS)));
  if (from > to) throw BadRequest('The start date must be before the end date');
  const start = istDay(from);
  const end = new Date(istDay(to).getTime() + DAY_MS);
  if (end.getTime() - start.getTime() > 3 * 366 * DAY_MS)
    throw BadRequest('Choose a range of at most 3 years');
  if (groupBy === 'day' && end.getTime() - start.getTime() > 400 * DAY_MS)
    throw BadRequest('Group by month for ranges longer than a year');

  const fmt = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const sequelize = getSequelize();
  const replacements = { sellerId, start, end };
  const sums = (key: string) =>
    sequelize.query<SumRow>(
      `SELECT ${key} AS k, l.entry_type, COUNT(*) AS n, SUM(l.gross_paise) AS g,
              SUM(l.commission_paise) AS c, SUM(l.net_paise) AS net
         FROM mkt_sale_ledger l
        WHERE l.seller_id = :sellerId AND l.created_at >= :start AND l.created_at < :end
        GROUP BY k, l.entry_type`,
      { type: QueryTypes.SELECT, replacements },
    );
  const [byPeriod, byCourse, enrolments, courses, balance, settings, account] = await Promise.all([
    sums(`DATE_FORMAT(${IST}, '${fmt}')`),
    sums('l.course_id'),
    sequelize.query<{ course_id: number; n: number | string }>(
      `SELECT e.course_id, COUNT(*) AS n
         FROM mkt_enrolments e JOIN mkt_courses c ON c.id = e.course_id
        WHERE c.seller_id = :sellerId AND e.created_at >= :start AND e.created_at < :end
        GROUP BY e.course_id`,
      { type: QueryTypes.SELECT, replacements },
    ),
    MktCourse.findAll({ where: { sellerId }, attributes: ['id', 'title'] }),
    sellerBalance(sellerId),
    payoutSettings(),
    MktPayoutAccount.count({ where: { sellerId } }),
  ]);

  const totals = emptyTotals();
  const series = new Map<string, MktRevenuePoint>(
    periods(from, to, groupBy).map((p) => [p, { period: p, ...emptyTotals() }]),
  );
  for (const r of byPeriod) {
    add(totals, r);
    const key = String(r.k);
    const point = series.get(key) ?? { period: key, ...emptyTotals() };
    add(point, r);
    series.set(key, point);
  }

  const perCourse = new Map<number, MktCourseRevenueDto>();
  const courseRow = (id: number) => {
    const existing = perCourse.get(id);
    if (existing) return existing;
    const row: MktCourseRevenueDto = {
      courseId: id,
      title: courses.find((c) => c.id === id)?.title ?? `Course #${id}`,
      sales: 0,
      refunds: 0,
      enrolments: 0,
      grossPaise: 0,
      netPaise: 0,
    };
    perCourse.set(id, row);
    return row;
  };
  for (const r of byCourse) {
    const t = emptyTotals();
    add(t, r);
    const row = courseRow(Number(r.k));
    row.sales += t.sales;
    row.refunds += t.refunds;
    row.grossPaise += t.grossPaise;
    row.netPaise += t.netPaise;
  }
  for (const e of enrolments) courseRow(Number(e.course_id)).enrolments = Number(e.n);

  return {
    from,
    to,
    groupBy,
    totals,
    series: [...series.values()].sort((a, b) => a.period.localeCompare(b.period)),
    courses: [...perCourse.values()].sort((a, b) => b.netPaise - a.netPaise || b.enrolments - a.enrolments),
    balance,
    settings: settingsDto(settings),
    hasPayoutAccount: account > 0,
  };
}
