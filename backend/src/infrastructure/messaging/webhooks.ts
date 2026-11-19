import crypto from 'node:crypto';

/**
 * Vendor delivery-status and inbound-message webhooks: signature checks and payload parsing.
 * Pure functions; the notifications module looks up the provider, applies the receipts (forward
 * only) and records WhatsApp/SMS opt-outs.
 */
export type ReceiptStatus = 'sent' | 'delivered' | 'failed';

export interface DeliveryReceipt {
  /** Vendor message ids this receipt may refer to (MSG91 reports both its request id and the wamid). */
  ids: string[];
  status: ReceiptStatus;
  error?: string;
}

export interface InboundText {
  channel: 'sms' | 'whatsapp';
  /** Sender in international digits (`919876543210`). */
  from: string;
  text: string;
}

export interface WebhookEvents {
  receipts: DeliveryReceipt[];
  inbound: InboundText[];
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const text = (value: unknown, max = 500) => String(value ?? '').slice(0, max);
/** Status lookup that ignores inherited keys (`constructor`…) in untrusted payloads. */
const statusOf = (map: Record<string, ReceiptStatus>, key: string): ReceiptStatus | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

// ------------------------------------------------------------------ Twilio

type FormParams = Record<string, string | string[] | undefined>;

/** `X-Twilio-Signature`: base64 HMAC-SHA1 of the URL followed by the sorted POST parameters. */
export function twilioSignature(authToken: string, url: string, params: FormParams): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      const values = Array.isArray(value) ? [...value].sort() : [value ?? ''];
      return acc + values.map((v) => key + v).join('');
    }, url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Twilio signs the URL as configured; accept it with and without the default port, as its SDKs do. */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: FormParams,
  header: string | undefined,
): boolean {
  if (!header || !authToken) return false;
  const candidates = new Set([url]);
  try {
    const parsed = new URL(url);
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    if (parsed.port) {
      parsed.port = '';
      candidates.add(parsed.toString());
    } else {
      candidates.add(
        `${parsed.protocol}//${parsed.hostname}:${defaultPort}${parsed.pathname}${parsed.search}`,
      );
    }
  } catch {
    return false;
  }
  return [...candidates].some((candidate) =>
    safeEqual(twilioSignature(authToken, candidate, params), header),
  );
}

const TWILIO_STATUSES: Record<string, ReceiptStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'delivered',
  undelivered: 'failed',
  failed: 'failed',
  canceled: 'failed',
};

export function parseTwilio(params: FormParams): WebhookEvents {
  const get = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const events: WebhookEvents = { receipts: [], inbound: [] };
  const sid = get('MessageSid') ?? get('SmsSid');
  const status = get('MessageStatus') ?? '';
  const mapped = statusOf(TWILIO_STATUSES, status.toLowerCase());
  if (sid && mapped) {
    const code = get('ErrorCode');
    events.receipts.push({
      ids: [sid],
      status: mapped,
      error: mapped === 'failed' ? `Twilio ${status}${code ? ` (error ${digits(code)})` : ''}` : undefined,
    });
  } else if (get('Body') !== undefined && get('From')) {
    const from = get('From') ?? '';
    events.inbound.push({
      channel: /^whatsapp:/i.test(from) ? 'whatsapp' : 'sms',
      from: digits(from),
      text: text(get('Body')),
    });
  }
  return events;
}

// ------------------------------------------------------------------ WhatsApp Cloud API (Meta)

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with the app secret>`. */
export function verifyMetaSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !appSecret || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(header.slice(7).toLowerCase(), expected);
}

/** Verify token for Meta's subscription handshake, shown to the admin next to the webhook URL. */
export const whatsappVerifyToken = (webhookKey: string) =>
  crypto.createHash('sha256').update(`whatsapp-verify:${webhookKey}`).digest('hex').slice(0, 32);

interface MetaPayload {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        statuses?: {
          id?: string;
          status?: string;
          errors?: { code?: number; title?: string; message?: string }[];
        }[];
        messages?: {
          from?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string; payload?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
        }[];
      };
    }[];
  }[];
}

export function parseWhatsAppCloud(payload: unknown): WebhookEvents {
  const events: WebhookEvents = { receipts: [], inbound: [] };
  for (const entry of (payload as MetaPayload)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const s of value.statuses ?? []) {
        const status = String(s.status ?? '').toLowerCase();
        const mapped: ReceiptStatus | undefined =
          status === 'delivered' || status === 'read'
            ? 'delivered'
            : status === 'failed'
              ? 'failed'
              : status === 'sent'
                ? 'sent'
                : undefined;
        if (typeof s.id !== 'string' || !s.id || !mapped) continue;
        const e = s.errors?.[0];
        events.receipts.push({
          ids: [s.id],
          status: mapped,
          error:
            mapped === 'failed'
              ? `WhatsApp: ${text(e?.title || e?.message || 'failed', 150)}${e?.code ? ` (error ${e.code})` : ''}`
              : undefined,
        });
      }
      for (const m of value.messages ?? []) {
        const body =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title;
        if (m.from && body !== undefined)
          events.inbound.push({ channel: 'whatsapp', from: digits(m.from), text: text(body) });
      }
    }
  }
  return events;
}

// ------------------------------------------------------------------ MSG91

/** SMS delivery-report codes (`1` delivered); anything else is still in progress. */
const MSG91_SMS_FAILED = new Set(['2', '9', '16', '17', '25', '26']);
const MSG91_WORDS: Record<string, ReceiptStatus> = {
  delivered: 'delivered',
  read: 'delivered',
  sent: 'sent',
  failed: 'failed',
  rejected: 'failed',
  undelivered: 'failed',
  ndnc: 'failed',
  blocked: 'failed',
};

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function msg91Status(status: unknown, desc?: unknown): ReceiptStatus | undefined {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (s === '1') return 'delivered';
  if (MSG91_SMS_FAILED.has(s)) return 'failed';
  return (
    statusOf(MSG91_WORDS, s) ??
    statusOf(
      MSG91_WORDS,
      String(desc ?? '')
        .trim()
        .toLowerCase(),
    )
  );
}

/**
 * MSG91 posts SMS delivery reports as `data=[{requestId, report: [{number, status, desc}]}]` (form
 * or JSON) and WhatsApp events as JSON objects (`requestId`, `uuid`, `eventName`, `direction`…).
 */
export function parseMsg91(body: unknown): WebhookEvents {
  const events: WebhookEvents = { receipts: [], inbound: [] };
  const root = parseJson(body) as Record<string, unknown> | unknown[] | undefined;
  const data = Array.isArray(root) ? root : root && 'data' in root ? parseJson(root.data) : root;
  const items = (Array.isArray(data) ? data : data ? [data] : []) as Record<string, unknown>[];
  for (const item of items.slice(0, 1000)) {
    if (!item || typeof item !== 'object') continue;
    const ids = [item.requestId, item.request_id, item.uuid].filter(
      (v): v is string => typeof v === 'string' && !!v,
    );
    if (String(item.direction ?? '') === '0') {
      const content = parseJson(item.content) as { text?: string; body?: string } | undefined;
      const button = parseJson(item.button) as { text?: string; payload?: string } | undefined;
      const message = item.text ?? content?.text ?? content?.body ?? button?.text ?? button?.payload;
      const from = item.customerNumber ?? item.sender;
      if (from && typeof message === 'string') {
        events.inbound.push({ channel: 'whatsapp', from: digits(from), text: text(message) });
      }
      continue;
    }
    const reports = Array.isArray(item.report) ? (item.report as Record<string, unknown>[]) : [item];
    for (const report of reports.slice(0, 100)) {
      const status = msg91Status(report.status ?? item.eventName ?? item.status, report.desc);
      if (!ids.length || !status) continue;
      const reason = report.desc ?? item.reason;
      events.receipts.push({
        ids,
        status,
        error: status === 'failed' ? `MSG91: ${text(reason || 'failed', 150)}` : undefined,
      });
    }
  }
  return events;
}

// ------------------------------------------------------------------ Consent keywords

const OPT_OUT = new Set([
  'STOP',
  'STOPALL',
  'STOP ALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'OPTOUT',
  'OPT OUT',
]);
const OPT_IN = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'OPTIN', 'OPT IN']);

/** Standard opt-out/opt-in keywords; the whole message must be the keyword. */
export function consentKeyword(message: string): 'opt-out' | 'opt-in' | null {
  const word = message
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (OPT_OUT.has(word)) return 'opt-out';
  if (OPT_IN.has(word)) return 'opt-in';
  return null;
}
