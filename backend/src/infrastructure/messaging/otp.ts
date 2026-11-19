import type { OutboundMessage } from './types';

/**
 * Login OTP SMS. The text matches the DLT template documented in docs/integrations/messaging.md;
 * vendors with their own templates (MSG91 Flow) render it from `otp` and `minutes`.
 */
export function otpSms(to: string, code: string, ttlSeconds: number): OutboundMessage {
  const minutes = String(Math.max(1, Math.round(ttlSeconds / 60)));
  return {
    to,
    body: `${code} is your verification code. It expires in ${minutes} minutes.`,
    templateKey: 'otp',
    variables: [
      { name: 'otp', value: code },
      { name: 'minutes', value: minutes },
    ],
  };
}
