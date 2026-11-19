import { config } from '../config';

/**
 * Mobiles are stored as entered (`/^\+?\d{10,15}$/`, usually 10 digits without a country code).
 * Vendors want the international form: digits with the country code (`919876543210`).
 */
export function msisdn(mobile: string): string {
  const raw = mobile.replace(/^whatsapp:/i, '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || raw.startsWith('00')) return digits.replace(/^00/, '');
  if (digits.length === 10) return config.MESSAGING_DEFAULT_COUNTRY_CODE + digits;
  if (digits.length === 11 && digits.startsWith('0'))
    return config.MESSAGING_DEFAULT_COUNTRY_CODE + digits.slice(1);
  return digits;
}

/** E.164 with the plus sign (`+919876543210`), as Twilio expects. */
export const e164 = (mobile: string): string => `+${msisdn(mobile)}`;

/** Candidate stored forms of an international number, for matching inbound senders to users. */
export function storedMobileForms(international: string): string[] {
  const digits = international.replace(/\D/g, '');
  const cc = config.MESSAGING_DEFAULT_COUNTRY_CODE;
  const forms = new Set([digits, `+${digits}`]);
  if (digits.startsWith(cc) && digits.length - cc.length === 10) {
    const local = digits.slice(cc.length);
    forms.add(local);
    forms.add(`0${local}`);
  }
  return [...forms];
}
