import { config } from '../../infrastructure/config';
import { hmac, safeEqual } from '../../infrastructure/crypto';
import { NotFound } from '../../shared/errors';
import { SubscriptionCreditNote } from './models';
import { creditNotePdf, findInvoice, invoicePdf, platform } from './invoices.service';

/** Short-lived link to an invoice or credit note PDF (opened in a browser tab / the system viewer). */
interface DocumentClaims {
  /** kind: invoice or credit note */
  k: 'inv' | 'cn';
  /** document id */
  d: number;
  /** institute id of the requester (null: super admin) */
  i: number | null;
  /** expiry (unix seconds) */
  e: number;
}

const secret = () => `${config.FILE_URL_SECRET}:saas-document`;

export function signDocumentToken(
  kind: DocumentClaims['k'],
  id: number,
  instituteId: number | null,
  ttlSeconds = config.SIGNED_URL_TTL_SECONDS,
) {
  const claims: DocumentClaims = {
    k: kind,
    d: id,
    i: instituteId,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${body}.${hmac(body, secret())}`;
  return {
    url: `${config.API_PUBLIC_URL}/api/subscriptions/public/documents/${token}`,
    expiresAt: new Date(claims.e * 1000),
  };
}

function verifyDocumentToken(token: string): DocumentClaims | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body, secret()))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as DocumentClaims;
    if ((c.k !== 'inv' && c.k !== 'cn') || typeof c.d !== 'number' || c.e < Date.now() / 1000) return null;
    return c;
  } catch {
    return null;
  }
}

const fileName = (prefix: string, number: string) =>
  `${prefix}-${number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;

/** Renders the PDF a signed link points to (rendered on demand from the stored document). */
export async function renderSignedDocument(token: string): Promise<{ buffer: Buffer; fileName: string }> {
  const c = verifyDocumentToken(token);
  if (!c) throw NotFound('Document');
  if (c.k === 'inv') {
    const inv = await findInvoice(c.d, c.i);
    return { buffer: invoicePdf(inv), fileName: fileName('invoice', inv.number) };
  }
  const where = c.i === null ? { id: c.d } : { instituteId: c.i, id: c.d };
  const note = await SubscriptionCreditNote.findOne(c.i === null ? platform({ where }) : { where });
  if (!note) throw NotFound('Document');
  const inv = await findInvoice(note.invoiceId, null);
  return { buffer: creditNotePdf(note, inv), fileName: fileName('credit-note', note.number) };
}
