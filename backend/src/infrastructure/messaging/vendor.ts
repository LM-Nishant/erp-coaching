import { MessagingError } from './errors';
import type { Channel, ProviderSettings } from './types';

/** Helpers shared by the vendor adapters. */

export function setting(settings: ProviderSettings, key: string): string {
  const value = settings[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function requireSetting(
  vendor: string,
  settings: ProviderSettings,
  key: string,
  label: string,
): string {
  const value = setting(settings, key);
  if (!value) throw new MessagingError(`${vendor}: ${label} is not configured`, { code: 'NOT_CONFIGURED' });
  return value;
}

/** Settings that end up in a vendor URL must have the shape the vendor documents. */
export function checkFormat(vendor: string, value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new MessagingError(`${vendor}: the ${label} does not look right; check the provider settings`, {
      code: 'INVALID_SETTINGS',
    });
  }
  return value;
}

export function unsupportedChannel(vendor: string, channel: Channel): MessagingError {
  return new MessagingError(`${vendor} does not send ${channel} messages`, { code: 'UNSUPPORTED_CHANNEL' });
}

/** Vendor error text for delivery records and logs: one line, bounded. */
export function vendorText(value: unknown, max = 200): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** WhatsApp template ids are `name` or `name:language` (`fee_receipt:en_US`). */
export function splitTemplate(id: string, fallbackLanguage: string): { name: string; language: string } {
  const [name, language] = id.split(':');
  return { name: name.trim(), language: (language || fallbackLanguage || 'en').trim() };
}

/** WhatsApp rejects empty parameters, line breaks, tabs and runs of more than four spaces. */
export function whatsappParam(value: string): string {
  const text = (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim();
  return text || '-';
}

/** True unless the admin turned the opt-in requirement off (`requireOptIn: 'no'`). */
export const optInRequired = (channel: Channel, settings: ProviderSettings) =>
  channel === 'whatsapp' && setting(settings, 'requireOptIn') !== 'no';
