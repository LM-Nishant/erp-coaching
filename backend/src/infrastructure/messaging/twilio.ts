import { MessagingError, retryAfterMs, transientStatus } from './errors';
import { e164 } from './phone';
import { vendorFetch, type HttpResponse } from './transport';
import type {
  Channel,
  MessagingProvider,
  OutboundMessage,
  ProviderOptions,
  ProviderSettings,
  SendResult,
} from './types';
import { checkFormat, optInRequired, requireSetting, unsupportedChannel, vendorText } from './vendor';

/**
 * Twilio Programmable Messaging (https://www.twilio.com/docs/messaging/api/message-resource): SMS,
 * and WhatsApp through `whatsapp:` addresses. Content templates (`HX…` Content SIDs) carry
 * positional variables; delivery statuses come back on the per-message StatusCallback URL.
 * Twilio test credentials work as they are (magic numbers, nothing is delivered).
 */
export const TWILIO_API = 'https://api.twilio.com/2010-04-01';

const VENDOR = 'Twilio';
/** Twilio error codes worth retrying: rate limits and temporary unavailability. */
const TRANSIENT_CODES = new Set([20429, 20500, 20503, 30001, 63018]);

export class TwilioProvider implements MessagingProvider {
  readonly name = 'twilio';
  readonly requiresOptIn: boolean;

  constructor(
    readonly channel: Channel,
    private readonly settings: ProviderSettings,
    private readonly options: ProviderOptions = {},
  ) {
    this.requiresOptIn = optInRequired(channel, settings);
  }

  private account() {
    const sid = checkFormat(
      VENDOR,
      requireSetting(VENDOR, this.settings, 'accountSid', 'Account SID'),
      /^AC[0-9a-fA-F]{32}$/,
      'Account SID',
    );
    const token = requireSetting(VENDOR, this.settings, 'authToken', 'auth token');
    return { sid, authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.channel !== 'sms' && this.channel !== 'whatsapp') throw unsupportedChannel(VENDOR, this.channel);
    const { sid, authorization } = this.account();
    const whatsapp = this.channel === 'whatsapp';
    const from = requireSetting(VENDOR, this.settings, 'from', 'from number');
    const form = new URLSearchParams();
    form.set('To', whatsapp ? `whatsapp:${e164(message.to)}` : e164(message.to));
    if (/^MG[0-9a-fA-F]{32}$/.test(from)) form.set('MessagingServiceSid', from);
    else form.set('From', whatsapp && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from);
    const template = (message.templateId ?? '').trim();
    if (/^HX[0-9a-fA-F]{32}$/.test(template)) {
      form.set('ContentSid', template);
      const variables = message.variables ?? [];
      if (variables.length) {
        form.set(
          'ContentVariables',
          JSON.stringify(Object.fromEntries(variables.map((v, i) => [String(i + 1), v.value]))),
        );
      }
    } else {
      form.set('Body', message.body);
      // A PDF receipt goes as WhatsApp media; MMS is US/Canada only, so SMS keeps the text alone.
      if (whatsapp && message.document) form.set('MediaUrl', message.document.url);
    }
    if (this.options.webhookUrl) form.set('StatusCallback', this.options.webhookUrl);
    const res = await vendorFetch(VENDOR, `${TWILIO_API}/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    const body = (res.json ?? {}) as { sid?: string; status?: string };
    if (res.status >= 200 && res.status < 300 && body.sid)
      return { providerMessageId: body.sid, status: 'sent' };
    throw twilioError(res, 'Twilio did not accept the message');
  }

  /** Reads the account: checks the SID and auth token without sending anything. */
  async verify(): Promise<string> {
    const { sid, authorization } = this.account();
    const res = await vendorFetch(VENDOR, `${TWILIO_API}/Accounts/${sid}.json`, {
      method: 'GET',
      headers: { authorization, accept: 'application/json' },
    });
    const body = (res.json ?? {}) as { friendly_name?: string; status?: string; code?: number };
    if (res.status === 200) {
      return `Twilio accepted the credentials (account "${vendorText(body.friendly_name, 80)}", ${vendorText(body.status, 20)})`;
    }
    // Test credentials cannot read the account resource, which proves they are valid.
    if (res.status === 403 && Number(body.code) === 20008) {
      return 'Twilio accepted the test credentials (test mode: messages are not delivered)';
    }
    if (res.status === 401) {
      throw new MessagingError('Twilio rejected the Account SID or auth token', {
        code: 'TWILIO_20003',
        status: 401,
      });
    }
    throw twilioError(res, 'Twilio could not check the credentials');
  }
}

function twilioError(res: HttpResponse, fallback: string): MessagingError {
  const body = (res.json ?? {}) as { code?: number; message?: string };
  const code = Number(body.code) || 0;
  const detail = vendorText(body.message) || `HTTP ${res.status}`;
  return new MessagingError(`${fallback}: ${detail}${code ? ` (Twilio error ${code})` : ''}`, {
    code: code ? `TWILIO_${code}` : `HTTP_${res.status}`,
    transient: transientStatus(res.status) || TRANSIENT_CODES.has(code),
    status: res.status,
    retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
  });
}
