import { MessagingError, retryAfterMs, transientStatus } from './errors';
import { msisdn } from './phone';
import { vendorFetch, type HttpResponse } from './transport';
import type { Channel, MessagingProvider, OutboundMessage, ProviderSettings, SendResult } from './types';
import {
  checkFormat,
  optInRequired,
  requireSetting,
  setting,
  splitTemplate,
  unsupportedChannel,
  vendorText,
  whatsappParam,
} from './vendor';

/**
 * Meta WhatsApp Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api). Business-
 * initiated messages must use an approved template (`name` or `name:language`); free text and
 * documents without a template only reach users who wrote to the business in the last 24 hours.
 */
export const GRAPH_API = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_VERSION = 'v27.0';

const VENDOR = 'WhatsApp Cloud API';
/** Graph/WhatsApp error codes that clear up on their own (rate limits, temporary outages). */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131056, 133004]);

export class WhatsAppCloudProvider implements MessagingProvider {
  readonly name = 'whatsapp-cloud';
  readonly requiresOptIn: boolean;

  constructor(
    readonly channel: Channel,
    private readonly settings: ProviderSettings,
  ) {
    this.requiresOptIn = optInRequired(channel, settings);
  }

  private endpoint(suffix = '') {
    const version = checkFormat(
      VENDOR,
      setting(this.settings, 'apiVersion') || DEFAULT_GRAPH_VERSION,
      /^v\d{1,3}\.\d{1,2}$/,
      'Graph API version (v27.0)',
    );
    const phoneNumberId = checkFormat(
      VENDOR,
      requireSetting(VENDOR, this.settings, 'phoneNumberId', 'phone number id'),
      /^\d{5,30}$/,
      'phone number id',
    );
    return `${GRAPH_API}/${version}/${phoneNumberId}${suffix}`;
  }

  private headers() {
    return {
      authorization: `Bearer ${requireSetting(VENDOR, this.settings, 'accessToken', 'access token')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.channel !== 'whatsapp') throw unsupportedChannel(VENDOR, this.channel);
    const res = await vendorFetch(VENDOR, this.endpoint('/messages'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: msisdn(message.to),
        ...this.content(message),
      }),
    });
    const body = (res.json ?? {}) as { messages?: { id?: string }[] };
    const id = body.messages?.[0]?.id;
    if (res.status >= 200 && res.status < 300 && id) return { providerMessageId: id, status: 'sent' };
    throw graphError(res, 'WhatsApp did not accept the message');
  }

  private content(message: OutboundMessage): Record<string, unknown> {
    const templateId = (message.templateId ?? '').trim();
    if (templateId) {
      const { name, language } = splitTemplate(templateId, setting(this.settings, 'defaultLanguage'));
      const components: Record<string, unknown>[] = [];
      if (message.document) {
        components.push({
          type: 'header',
          parameters: [
            {
              type: 'document',
              document: { link: message.document.url, filename: message.document.filename },
            },
          ],
        });
      }
      const variables = message.variables ?? [];
      if (variables.length) {
        components.push({
          type: 'body',
          parameters: variables.map((v) => ({ type: 'text', text: whatsappParam(v.value) })),
        });
      }
      return { type: 'template', template: { name, language: { code: language }, components } };
    }
    if (message.document) {
      return {
        type: 'document',
        document: {
          link: message.document.url,
          filename: message.document.filename,
          caption: message.body.slice(0, 1024),
        },
      };
    }
    return { type: 'text', text: { preview_url: false, body: message.body.slice(0, 4096) } };
  }

  /** Reads the phone number: checks the token and phone number id without sending anything. */
  async verify(): Promise<string> {
    const res = await vendorFetch(VENDOR, `${this.endpoint()}?fields=display_phone_number,verified_name`, {
      method: 'GET',
      headers: this.headers(),
    });
    const body = (res.json ?? {}) as { display_phone_number?: string; verified_name?: string };
    if (res.status === 200 && body.display_phone_number) {
      const name = body.verified_name ? ` (${vendorText(body.verified_name, 80)})` : '';
      return `WhatsApp accepted the access token for ${vendorText(body.display_phone_number, 30)}${name}`;
    }
    throw graphError(res, 'WhatsApp rejected the access token or phone number id');
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

function graphError(res: HttpResponse, fallback: string): MessagingError {
  const error = ((res.json ?? {}) as GraphErrorBody).error ?? {};
  const code = Number(error.code) || 0;
  const detail = vendorText(error.error_data?.details || error.message) || `HTTP ${res.status}`;
  return new MessagingError(`${fallback}: ${detail}${code ? ` (error ${code})` : ''}`, {
    code: code ? `WHATSAPP_${code}` : `HTTP_${res.status}`,
    transient: transientStatus(res.status) || TRANSIENT_CODES.has(code),
    status: res.status,
    retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
  });
}
