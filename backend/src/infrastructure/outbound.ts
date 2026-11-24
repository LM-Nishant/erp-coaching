/**
 * Process-wide switch that stops this process from contacting real people. While it is on,
 * notifications to external channels (SMS, WhatsApp, email, push) are recorded as `skipped` with
 * the given reason and never handed to a provider; in-app notifications are unaffected.
 * Used by the demo data seed (`npm run db:seed:demo`).
 */
let suppressedReason: string | null = null;

export function suppressOutbound(reason: string): void {
  suppressedReason = reason;
}

export function resumeOutbound(): void {
  suppressedReason = null;
}

/** The suppression reason, or null when outbound messages are allowed. */
export function outboundSuppressed(): string | null {
  return suppressedReason;
}
