import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { AppError } from '../../shared/errors';

/**
 * Custom-domain ownership: the institute publishes a TXT record `_erp-verification.<domain>` with the
 * value `erp-verification=<token>`, where the token is generated per saved domain. Only verified domains
 * are served.
 */
const RECORD_LABEL = '_erp-verification';
const VALUE_PREFIX = 'erp-verification=';
const LOOKUP_TIMEOUT_MS = 4000;

export type TxtResolver = (name: string) => Promise<string[][]>;

const systemResolver: TxtResolver = (name) =>
  new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 2 }).resolveTxt(name);

let resolveTxt: TxtResolver = systemResolver;

/** Tests replace the DNS lookup; `null` restores the system resolver. */
export function setTxtResolver(resolver: TxtResolver | null) {
  resolveTxt = resolver ?? systemResolver;
}

export function newDomainToken() {
  return randomBytes(16).toString('hex');
}

export function verificationRecord(domain: string, token: string) {
  return { recordName: `${RECORD_LABEL}.${domain}`, recordValue: `${VALUE_PREFIX}${token}` };
}

/** Whether the domain publishes the TXT record for `token`. Throws 503 when DNS can't answer. */
export async function hasVerificationRecord(domain: string, token: string): Promise<boolean> {
  const { recordName, recordValue } = verificationRecord(domain, token);
  let records: string[][];
  try {
    records = await resolveTxt(recordName);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND') return false;
    throw new AppError(
      503,
      'DNS_LOOKUP_FAILED',
      `Couldn't look up ${recordName}. Try again in a few minutes.`,
    );
  }
  // Long TXT values arrive split into chunks of up to 255 characters.
  return records.some((chunks) => chunks.join('').trim() === recordValue);
}
