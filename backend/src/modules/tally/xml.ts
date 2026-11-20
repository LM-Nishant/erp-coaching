/**
 * Tally XML import files ("Import Data" envelopes) for TallyPrime and Tally.ERP 9.
 *
 * Output is pure ASCII with no XML declaration, like Tally's own exports: everything outside
 * printable ASCII is written as a numeric character reference, so the files read the same whatever
 * encoding Tally assumes. Amounts follow Tally's sign convention: a debit is ISDEEMEDPOSITIVE=Yes
 * with a negative AMOUNT, a credit ISDEEMEDPOSITIVE=No with a positive AMOUNT, so every voucher's
 * AMOUNTs sum to zero.
 */

/** A ledger line: positive = debit, negative = credit (paise). */
export interface XmlLine {
  ledger: string;
  amount: number;
}

export interface XmlVoucher {
  remoteId: string;
  voucherType: string;
  /** YYYY-MM-DD */
  date: string;
  voucherNumber: string | null;
  partyLedger: string | null;
  narration: string | null;
  lines: XmlLine[];
}

export interface XmlLedger {
  name: string;
  parent: string;
  /** Central Tax / State Tax / Integrated Tax for split GST output ledgers. */
  gstDutyHead?: string | null;
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Characters XML 1.0 does not allow, plus DEL and C1 controls. */
function invalidChar(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp === 0xfffe ||
    cp === 0xffff
  );
}

/** Escapes text for element content or a double-quoted attribute. */
export function xmlText(value: string | null | undefined): string {
  if (value == null) return '';
  let out = '';
  const text = String(value).replace(/\r\n?/g, '\n');
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (invalidChar(cp)) continue;
    if (ch === '\n') out += '&#13;&#10;';
    else if (ch === '\t') out += '&#9;';
    else if (ENTITIES[ch]) out += ENTITIES[ch];
    else if (cp > 0x7e) out += `&#${cp};`;
    else out += ch;
  }
  return out;
}

/** Paise → Tally amount ("1234.50", "-0.05"). */
export function tallyAmount(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error(`Invalid amount ${paise}`);
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${paise < 0 ? '-' : ''}${rupees}.${fraction}`;
}

/** YYYY-MM-DD → YYYYMMDD. */
export function tallyDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date ${date}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

const el = (indent: string, tag: string, value: string | null | undefined) =>
  `${indent}<${tag}>${xmlText(value)}</${tag}>`;

function envelope(reportName: 'All Masters' | 'Vouchers', company: string | null, messages: string[]) {
  const vars = company
    ? ['    <STATICVARIABLES>', el('     ', 'SVCURRENTCOMPANY', company), '    </STATICVARIABLES>']
    : [];
  return [
    '<ENVELOPE>',
    ' <HEADER>',
    '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
    ' </HEADER>',
    ' <BODY>',
    '  <IMPORTDATA>',
    '   <REQUESTDESC>',
    `    <REPORTNAME>${reportName}</REPORTNAME>`,
    ...vars,
    '   </REQUESTDESC>',
    '   <REQUESTDATA>',
    ...messages,
    '   </REQUESTDATA>',
    '  </IMPORTDATA>',
    ' </BODY>',
    '</ENVELOPE>',
    '',
  ].join('\r\n');
}

const message = (body: string[]) =>
  ['    <TALLYMESSAGE xmlns:UDF="TallyUDF">', ...body, '    </TALLYMESSAGE>'].join('\r\n');

export function ledgerXml(l: XmlLedger): string {
  const i = '      ';
  const body = [
    `     <LEDGER NAME="${xmlText(l.name)}" ACTION="Create">`,
    el(i, 'PARENT', l.parent),
    el(i, 'ISBILLWISEON', 'No'),
    el(i, 'ISCOSTCENTRESON', 'No'),
  ];
  if (l.gstDutyHead) body.push(el(i, 'TAXTYPE', 'GST'), el(i, 'GSTDUTYHEAD', l.gstDutyHead));
  body.push(
    `${i}<LANGUAGENAME.LIST>`,
    `${i} <NAME.LIST TYPE="String">`,
    el(`${i}  `, 'NAME', l.name),
    `${i} </NAME.LIST>`,
    `${i} <LANGUAGEID> 1033</LANGUAGEID>`,
    `${i}</LANGUAGENAME.LIST>`,
    '     </LEDGER>',
  );
  return message(body);
}

/** Throws unless the voucher has two or more lines that sum to zero. */
export function assertBalanced(v: Pick<XmlVoucher, 'remoteId' | 'lines'>): void {
  if (v.lines.length < 2) throw new Error(`Voucher ${v.remoteId} needs at least two lines`);
  let sum = 0;
  for (const l of v.lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount === 0)
      throw new Error(`Voucher ${v.remoteId} has an invalid amount for ${l.ledger}`);
    sum += l.amount;
  }
  if (sum !== 0) throw new Error(`Voucher ${v.remoteId} does not balance (${sum})`);
}

export function voucherXml(v: XmlVoucher): string {
  assertBalanced(v);
  const i = '      ';
  const type = xmlText(v.voucherType);
  const body = [
    `     <VOUCHER REMOTEID="${xmlText(v.remoteId)}" VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    el(i, 'DATE', tallyDate(v.date)),
    el(i, 'EFFECTIVEDATE', tallyDate(v.date)),
    el(i, 'GUID', v.remoteId),
    el(i, 'VOUCHERTYPENAME', v.voucherType),
  ];
  if (v.voucherNumber) body.push(el(i, 'VOUCHERNUMBER', v.voucherNumber));
  if (v.partyLedger) body.push(el(i, 'PARTYLEDGERNAME', v.partyLedger));
  if (v.narration) body.push(el(i, 'NARRATION', v.narration));
  body.push(el(i, 'PERSISTEDVIEW', 'Accounting Voucher View'));
  for (const l of v.lines) {
    const debit = l.amount > 0;
    body.push(
      `${i}<ALLLEDGERENTRIES.LIST>`,
      el(`${i} `, 'LEDGERNAME', l.ledger),
      el(`${i} `, 'ISDEEMEDPOSITIVE', debit ? 'Yes' : 'No'),
      // Tally stores debits as negative amounts.
      el(`${i} `, 'AMOUNT', tallyAmount(-l.amount)),
      `${i}</ALLLEDGERENTRIES.LIST>`,
    );
  }
  body.push('     </VOUCHER>');
  return message(body);
}

export function mastersXml(company: string | null, ledgers: XmlLedger[]): string {
  return envelope('All Masters', company, ledgers.map(ledgerXml));
}

export function vouchersXml(company: string | null, vouchers: XmlVoucher[]): string {
  return envelope('Vouchers', company, vouchers.map(voucherXml));
}
