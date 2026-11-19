import { MessagingError, retryAfterMs, transientStatus } from './errors';
import { msisdn } from './phone';
import { vendorFetch, type HttpResponse } from './transport';
import type {
  Channel,
  MessagingProvider,
  OutboundMessage,
  ProviderSettings,
  SendResult,
  TemplateVariable,
} from './types';
import {
  optInRequired,
  requireSetting,
  setting,
  splitTemplate,
  unsupportedChannel,
  vendorText,
} from './vendor';

/**
 * MSG91 (https://docs.msg91.com). SMS goes through the DLT text API (`sendhttp.php`, template id
 * = the 19-digit DLT template id, sender = the DLT header, PE_ID = the DLT entity id) or, for
 * MSG91 template ids, the Flow API. WhatsApp sends approved templates from an integrated number.
 */
export const MSG91_SMS_URL = 'https://api.msg91.com/api/sendhttp.php';
export const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow';
export const MSG91_WHATSAPP_URL = 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
export const MSG91_BALANCE_URL = 'https://control.msg91.com/api/balance.php';

/** DLT template ids are long numbers; MSG91 template (flow) ids are 24-character hex strings. */
export const isDltTemplateId = (id: string) => /^\d{15,25}$/.test(id);

const VENDOR = 'MSG91';

export class Msg91Provider implements MessagingProvider {
  readonly name = 'msg91';
  readonly requiresOptIn: boolean;

  constructor(
    readonly channel: Channel,
    private readonly settings: ProviderSettings,
  ) {
    this.requiresOptIn = optInRequired(channel, settings);
  }

  private get authKey() {
    return requireSetting(VENDOR, this.settings, 'authKey', 'auth key');
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.channel === 'whatsapp') return this.sendWhatsApp(message);
    if (this.channel !== 'sms') throw unsupportedChannel(VENDOR, this.channel);
    const templateId =
      message.templateKey === 'otp'
        ? setting(this.settings, 'otpTemplateId')
        : (message.templateId ?? '').trim();
    if (message.templateKey === 'otp' && !templateId) {
      throw new MessagingError('MSG91: set the login OTP template id in the platform SMS settings', {
        code: 'TEMPLATE_REQUIRED',
      });
    }
    return templateId && !isDltTemplateId(templateId)
      ? this.sendFlow(templateId, message)
      : this.sendText(templateId, message);
  }

  /** DLT text SMS: the rendered text must match the registered DLT template. */
  private async sendText(dltTemplateId: string, message: OutboundMessage): Promise<SendResult> {
    const params = new URLSearchParams({
      authkey: this.authKey,
      mobiles: msisdn(message.to),
      message: message.body,
      sender: requireSetting(VENDOR, this.settings, 'senderId', 'sender id'),
      route: '4',
      response: 'json',
    });
    if (dltTemplateId) params.set('DLT_TE_ID', dltTemplateId);
    const entityId = setting(this.settings, 'dltEntityId');
    if (entityId) params.set('PE_ID', entityId);
    const res = await vendorFetch(VENDOR, `${MSG91_SMS_URL}?${params}`, { method: 'GET' });
    return { providerMessageId: requestId(res), status: 'sent' };
  }

  /** MSG91 template (Flow API): MSG91 renders the text from the template's `##variables##`. */
  private async sendFlow(templateId: string, message: OutboundMessage): Promise<SendResult> {
    const res = await vendorFetch(VENDOR, MSG91_FLOW_URL, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        template_id: templateId,
        short_url: '0',
        recipients: [{ mobiles: msisdn(message.to), ...flowVariables(message.variables ?? []) }],
      }),
    });
    return { providerMessageId: requestId(res), status: 'sent' };
  }

  private async sendWhatsApp(message: OutboundMessage): Promise<SendResult> {
    const templateId = (message.templateId ?? '').trim();
    if (!templateId) {
      throw new MessagingError(
        'MSG91 WhatsApp sends approved templates only: set the WhatsApp template name on this notification template',
        { code: 'TEMPLATE_REQUIRED' },
      );
    }
    const { name, language } = splitTemplate(templateId, setting(this.settings, 'defaultLanguage'));
    const components: Record<string, Record<string, string>> = {};
    if (message.document) {
      components.header_1 = {
        type: 'document',
        value: message.document.url,
        filename: message.document.filename,
      };
    }
    (message.variables ?? []).forEach((v, i) => {
      components[`body_${i + 1}`] = { type: 'text', value: v.value || '-' };
    });
    const res = await vendorFetch(VENDOR, MSG91_WHATSAPP_URL, {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        integrated_number: msisdn(
          requireSetting(VENDOR, this.settings, 'integratedNumber', 'integrated number'),
        ),
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp',
          type: 'template',
          template: {
            name,
            language: { code: language, policy: 'deterministic' },
            namespace: null,
            to_and_components: [{ to: [msisdn(message.to)], components }],
          },
        },
      }),
    });
    return { providerMessageId: requestId(res), status: 'sent' };
  }

  /** Balance lookup: checks the auth key without sending anything. */
  async verify(): Promise<string> {
    const params = new URLSearchParams({ authkey: this.authKey, type: '4' });
    const res = await vendorFetch(VENDOR, `${MSG91_BALANCE_URL}?${params}`, { method: 'GET' });
    const text = res.text.trim();
    if (res.status === 200 && /^-?\d+(\.\d+)?$/.test(text))
      return `MSG91 accepted the auth key (balance ${text})`;
    throw failure(res, 'MSG91 rejected the auth key');
  }

  private jsonHeaders() {
    return { authkey: this.authKey, 'content-type': 'application/json', accept: 'application/json' };
  }
}

/** Flow variables: positional (`VAR1`, `var1`) and by placeholder name (`student_name`, `OTP`). */
export function flowVariables(variables: TemplateVariable[]): Record<string, string> {
  const out: Record<string, string> = {};
  variables.forEach((v, i) => {
    const key = v.name.replace(/[^A-Za-z0-9_]/g, '_');
    for (const k of [key, key.toUpperCase(), key.split('_').pop() ?? key])
      if (k && !(k in out)) out[k] = v.value;
    out[`VAR${i + 1}`] = v.value;
    out[`var${i + 1}`] = v.value;
  });
  return out;
}

/** MSG91 answers `{type: 'success', message: '<request id>'}` (SMS) or `{request_id}` (WhatsApp). */
function requestId(res: HttpResponse): string {
  const body = (res.json ?? {}) as Record<string, unknown>;
  const ok =
    res.status >= 200 &&
    res.status < 300 &&
    body.type !== 'error' &&
    body.status !== 'fail' &&
    body.status !== 'error' &&
    body.hasError !== true;
  const id = body.request_id ?? body.requestId ?? (body.type === 'success' ? body.message : undefined);
  if (ok && typeof id === 'string' && id) return id;
  if (ok && !res.json && /^[A-Za-z0-9]{10,64}$/.test(res.text.trim())) return res.text.trim();
  throw failure(res, 'MSG91 did not accept the message');
}

function failure(res: HttpResponse, fallback: string): MessagingError {
  const body = (res.json ?? {}) as Record<string, unknown>;
  const errors = body.errors ?? body.message ?? body.msg;
  const detail = vendorText(typeof errors === 'string' ? errors : errors ? JSON.stringify(errors) : '');
  const code = vendorText(body.code ?? body.errorCode ?? '', 20);
  return new MessagingError(`${fallback}${detail ? `: ${detail}` : ` (HTTP ${res.status})`}`, {
    code: code ? `MSG91_${code}` : `HTTP_${res.status}`,
    transient: transientStatus(res.status),
    status: res.status,
    retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
  });
}
