import { AppError } from '../errors';

/**
 * Stored provider secrets (API keys, passwords, secret access keys) are kept when a settings form
 * leaves them blank. That reuse is only safe while the secret still goes where it was saved for:
 * otherwise anyone who can edit the form could point the provider at their own server (a new base
 * URL, SMTP host or storage endpoint) and have the stored secret sent there. These helpers make
 * saves and connection tests require the secret to be re-entered when a destination field changes.
 */

const normalise = (value: unknown) =>
  value === null || value === undefined ? '' : String(value).trim().replace(/\/+$/, '');

/** Destination fields whose value in `next` differs from `saved`. */
export function changedDestinationFields(saved: object, next: object, fields: readonly string[]): string[] {
  const value = (o: object, f: string) => normalise((o as Record<string, unknown>)[f]);
  return fields.filter((f) => value(saved, f) !== value(next, f));
}

/**
 * Throws 400 SECRET_REQUIRED when a stored secret would be reused (`reusing`) with changed
 * destination fields.
 */
export function assertStoredSecretReusable(reusing: boolean, changed: string[], secretLabel: string): void {
  if (!reusing || !changed.length) return;
  throw new AppError(
    400,
    'SECRET_REQUIRED',
    `Re-enter the ${secretLabel}: the saved one is only used with the settings it was saved for (changed: ${changed.join(', ')})`,
    { fields: changed },
  );
}

/** Messaging provider fields (see PROVIDER_FIELDS) that choose the server the provider's secrets go to. */
export const MESSAGING_DESTINATION_FIELDS: Record<string, readonly string[]> = {
  smtp: ['host', 'port', 'secure'],
};
