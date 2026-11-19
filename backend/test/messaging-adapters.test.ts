import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FcmProvider,
  MessagingError,
  Msg91Provider,
  SmtpProvider,
  TwilioProvider,
  WhatsAppCloudProvider,
  consentKeyword,
  createMessagingProvider,
  e164,
  isApnsToken,
  isTransientError,
  msisdn,
  otpSms,
  parseMsg91,
  parseTwilio,
  parseWhatsAppCloud,
  retryAfterMs,
  setMessagingTransport,
  storedMobileForms,
  twilioSignature,
  verifyMetaSignature,
  verifyTwilioSignature,
  whatsappVerifyToken,
  type Http2Response,
  type Mailer,
  type MessagingTransport,
} from '../src/infrastructure/messaging';
import { pushData } from '../src/infrastructure/messaging/apns';
import { flowVariables, isDltTemplateId } from '../src/infrastructure/messaging/msg91';

/** Vendor adapters against a mocked network boundary: nothing here reaches a vendor. 951… test mobiles. */

interface HttpCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
interface H2Call {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
type HttpReply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;
type MailOptions = Parameters<Mailer['sendMail']>[0];
type SmtpOptions = Parameters<MessagingTransport['createMailer']>[0];

function mockTransport(replies: {
  http?: (call: HttpCall) => HttpReply;
  h2?: (call: H2Call) => Http2Response | Error;
  mailer?: Partial<Mailer>;
}) {
  const http: HttpCall[] = [];
  const h2: H2Call[] = [];
  const mail: MailOptions[] = [];
  const smtp: SmtpOptions[] = [];
  let closed = 0;
  setMessagingTransport({
    fetch: async (url, init) => {
      const call = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === 'string' ? init.body : '',
      };
      http.push(call);
      const reply = replies.http?.(call) ?? { status: 500 };
      if (reply instanceof Error) throw reply;
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
      return new Response(text, { status: reply.status ?? 200, headers: reply.headers });
    },
    http2Request: async (origin, path, headers, body) => {
      const call = { origin, path, headers, body };
      h2.push(call);
      const reply = replies.h2?.(call) ?? { status: 500, headers: {}, body: '' };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    createMailer: (options) => {
      smtp.push(options);
      return {
        sendMail: async (m) => {
          mail.push(m);
          return replies.mailer?.sendMail
            ? replies.mailer.sendMail(m)
            : { messageId: '<msg-1@apex.test>', accepted: [m.to], rejected: [] };
        },
        verify: async () => (replies.mailer?.verify ? replies.mailer.verify() : true),
        close: () => {
          closed++;
        },
      };
    },
  });
  return { http, h2, mail, smtp, closed: () => closed };
}

afterEach(() => setMessagingTransport(null));

async function rejection(promise: Promise<unknown>): Promise<MessagingError> {
  const err = await promise.then(
    () => {
      throw new Error('Expected the call to fail');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MessagingError);
  return err as MessagingError;
}

const form = (call: HttpCall) => Object.fromEntries(new URLSearchParams(call.body));
const json = (call: HttpCall) => JSON.parse(call.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function decodeJwt(token: string) {
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
    signed: Buffer.from(`${h}.${p}`),
    signature: Buffer.from(s, 'base64url'),
  };
}

const TO = '9510000001';
const PDF = { url: 'https://api.apex.test/api/files/signed/abc?sig=x', filename: 'receipt-R-1.pdf' };

describe('webhook signatures (vendor-published examples)', () => {
  it('computes X-Twilio-Signature like the Twilio docs and SDK', () => {
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = (caller: string) => ({
      CallSid: 'CA1234567890ABCDE',
      Caller: caller,
      Digits: '1234',
      From: caller,
      To: '+18005551212',
    });
    expect(twilioSignature('12345', url, params('+12349013030'))).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
    expect(twilioSignature('12345', url, params('+14158675309'))).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
    expect(verifyTwilioSignature('12345', url, params('+14158675309'), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=')).toBe(
      true,
    );
  });

  it('accepts Twilio signatures with or without the default port, and nothing else', () => {
    const url = 'https://api.apex.test/api/notifications/public/webhooks/twilio/key-123456';
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const withPort = twilioSignature(
      'tok',
      'https://api.apex.test:443/api/notifications/public/webhooks/twilio/key-123456',
      params,
    );
    expect(verifyTwilioSignature('tok', url, params, withPort)).toBe(true);
    expect(verifyTwilioSignature('tok', url, params, twilioSignature('tok', url, params))).toBe(true);
    expect(verifyTwilioSignature('tok', url, { ...params, MessageStatus: 'failed' }, withPort)).toBe(false);
    expect(verifyTwilioSignature('other', url, params, withPort)).toBe(false);
    expect(verifyTwilioSignature('tok', url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature('', url, params, withPort)).toBe(false);
  });

  it('checks X-Hub-Signature-256 (HMAC-SHA256 of the raw body)', () => {
    // GitHub's published example of the same sha256=<hex HMAC> scheme Meta uses.
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    const secret = "It's a Secret to Everybody";
    expect(verifyMetaSignature(secret, Buffer.from('Hello, World!'), header)).toBe(true);
    expect(
      verifyMetaSignature(secret, Buffer.from('Hello, World!'), header.toUpperCase().replace('SHA', 'sha')),
    ).toBe(true);
    expect(verifyMetaSignature(secret, Buffer.from('Hello, World?'), header)).toBe(false);
    expect(verifyMetaSignature('wrong', Buffer.from('Hello, World!'), header)).toBe(false);
    expect(verifyMetaSignature(secret, Buffer.from('Hello, World!'), header.slice(7))).toBe(false);
    expect(verifyMetaSignature('', Buffer.from('Hello, World!'), header)).toBe(false);
    expect(verifyMetaSignature(secret, Buffer.from('Hello, World!'), undefined)).toBe(false);
  });

  it('derives a stable WhatsApp verify token per webhook key', () => {
    expect(whatsappVerifyToken('key-a')).toMatch(/^[0-9a-f]{32}$/);
    expect(whatsappVerifyToken('key-a')).toBe(whatsappVerifyToken('key-a'));
    expect(whatsappVerifyToken('key-a')).not.toBe(whatsappVerifyToken('key-b'));
  });
});

describe('webhook payloads', () => {
  it('reads Twilio status callbacks and inbound replies', () => {
    expect(parseTwilio({ MessageSid: 'SM1', MessageStatus: 'delivered', SmsStatus: 'delivered' })).toEqual({
      receipts: [{ ids: ['SM1'], status: 'delivered', error: undefined }],
      inbound: [],
    });
    expect(parseTwilio({ MessageSid: 'SM2', MessageStatus: 'read' }).receipts[0].status).toBe('delivered');
    expect(
      parseTwilio({ MessageSid: 'SM3', MessageStatus: 'undelivered', ErrorCode: '30003' }).receipts,
    ).toEqual([{ ids: ['SM3'], status: 'failed', error: 'Twilio undelivered (error 30003)' }]);
    expect(parseTwilio({ MessageSid: 'SM4', MessageStatus: 'queued' })).toEqual({
      receipts: [],
      inbound: [],
    });
    expect(
      parseTwilio({ MessageSid: 'SM5', SmsStatus: 'received', From: 'whatsapp:+919510000001', Body: 'STOP' }),
    ).toEqual({ receipts: [], inbound: [{ channel: 'whatsapp', from: '919510000001', text: 'STOP' }] });
    expect(parseTwilio({ MessageSid: 'SM6', From: '+919510000001', Body: 'start' }).inbound[0]).toEqual({
      channel: 'sms',
      from: '919510000001',
      text: 'start',
    });
    expect(parseTwilio({ MessageSid: 'SM7', MessageStatus: 'constructor' })).toEqual({
      receipts: [],
      inbound: [],
    });
  });

  it('reads WhatsApp Cloud API statuses and messages', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
                statuses: [
                  { id: 'wamid.READ', status: 'read', timestamp: '1700000000', recipient_id: '919510000001' },
                  { id: 'wamid.SENT', status: 'sent', recipient_id: '919510000001' },
                  {
                    id: 'wamid.FAIL',
                    status: 'failed',
                    errors: [{ code: 131026, title: 'Message undeliverable' }],
                  },
                  { id: 'wamid.ODD', status: 'deleted' },
                ],
                contacts: [{ profile: { name: 'Asha' }, wa_id: '919510000001' }],
                messages: [
                  { from: '919510000001', id: 'wamid.IN', type: 'text', text: { body: 'STOP' } },
                  {
                    from: '919510000002',
                    id: 'wamid.BTN',
                    type: 'button',
                    button: { text: 'Start', payload: 'x' },
                  },
                  { from: '919510000003', id: 'wamid.IMG', type: 'image' },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsAppCloud(payload)).toEqual({
      receipts: [
        { ids: ['wamid.READ'], status: 'delivered', error: undefined },
        { ids: ['wamid.SENT'], status: 'sent', error: undefined },
        { ids: ['wamid.FAIL'], status: 'failed', error: 'WhatsApp: Message undeliverable (error 131026)' },
      ],
      inbound: [
        { channel: 'whatsapp', from: '919510000001', text: 'STOP' },
        { channel: 'whatsapp', from: '919510000002', text: 'Start' },
      ],
    });
    expect(parseWhatsAppCloud(null)).toEqual({ receipts: [], inbound: [] });
    expect(parseWhatsAppCloud({ entry: 'x' })).toEqual({ receipts: [], inbound: [] });
  });

  it('reads MSG91 SMS delivery reports and WhatsApp events', () => {
    const report = [
      {
        senderId: 'APEXED',
        requestId: '3763646c3058373530393138',
        report: [{ date: '2026-01-05 11:24:21', number: '919510000001', status: '1', desc: 'DELIVERED' }],
      },
      {
        requestId: '3763646c3058373530393139',
        report: [{ number: '919510000002', status: '16', desc: 'Rejected' }],
      },
      {
        requestId: '3763646c3058373530393140',
        report: [{ number: '919510000003', status: '8', desc: 'Pending' }],
      },
    ];
    const expected = [
      { ids: ['3763646c3058373530393138'], status: 'delivered', error: undefined },
      { ids: ['3763646c3058373530393139'], status: 'failed', error: 'MSG91: Rejected' },
    ];
    // Form-encoded (`data=<json>`) as MSG91 posts it, or plain JSON.
    expect(parseMsg91({ data: JSON.stringify(report) }).receipts).toEqual(expected);
    expect(parseMsg91(report).receipts).toEqual(expected);
    expect(parseMsg91(JSON.stringify({ data: report })).receipts).toEqual(expected);

    expect(
      parseMsg91({ requestId: 'req-wa-1', uuid: 'wamid.MSG91', eventName: 'delivered', direction: '1' }),
    ).toEqual({
      receipts: [{ ids: ['req-wa-1', 'wamid.MSG91'], status: 'delivered', error: undefined }],
      inbound: [],
    });
    expect(parseMsg91({ direction: '0', customerNumber: '919510000001', text: 'stop' })).toEqual({
      receipts: [],
      inbound: [{ channel: 'whatsapp', from: '919510000001', text: 'stop' }],
    });
    expect(parseMsg91({ data: 'not json' })).toEqual({ receipts: [], inbound: [] });
  });

  it('recognises opt-out and opt-in keywords only as the whole message', () => {
    expect(consentKeyword('STOP')).toBe('opt-out');
    expect(consentKeyword('  stop! ')).toBe('opt-out');
    expect(consentKeyword('Opt-out')).toBe('opt-out');
    expect(consentKeyword('unsubscribe')).toBe('opt-out');
    expect(consentKeyword('Start')).toBe('opt-in');
    expect(consentKeyword('opt in')).toBe('opt-in');
    expect(consentKeyword('please stop the fee reminders')).toBeNull();
    expect(consentKeyword('')).toBeNull();
  });
});

describe('numbers and OTP text', () => {
  it('formats stored mobiles for vendors and matches replies back', () => {
    expect(msisdn(TO)).toBe('919510000001');
    expect(msisdn('09510000001')).toBe('919510000001');
    expect(msisdn('+1 (415) 555-2671')).toBe('14155552671');
    expect(msisdn('whatsapp:+919510000001')).toBe('919510000001');
    expect(msisdn('00447700900123')).toBe('447700900123');
    expect(e164(TO)).toBe('+919510000001');
    expect(storedMobileForms('919510000001').sort()).toEqual(
      ['09510000001', '+919510000001', '919510000001', '9510000001'].sort(),
    );
    expect(storedMobileForms('14155552671').sort()).toEqual(['+14155552671', '14155552671']);
  });

  it('builds the login OTP message for DLT and template vendors', () => {
    expect(otpSms(TO, '123456', 300)).toEqual({
      to: TO,
      body: '123456 is your verification code. It expires in 5 minutes.',
      templateKey: 'otp',
      variables: [
        { name: 'otp', value: '123456' },
        { name: 'minutes', value: '5' },
      ],
    });
    expect(otpSms(TO, '1', 20).body).toContain('expires in 1 minutes');
  });
});

describe('errors', () => {
  it('retries unclassified and transient errors only', () => {
    expect(isTransientError(new Error('boom'))).toBe(true);
    expect(isTransientError(new MessagingError('x', { code: 'X', transient: true }))).toBe(true);
    expect(isTransientError(new MessagingError('x', { code: 'X' }))).toBe(false);
  });

  it('reads Retry-After as seconds or a date, capped at an hour', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs('999999')).toBe(3_600_000);
    const date = retryAfterMs(new Date(Date.now() + 120_000).toUTCString())!;
    expect(date).toBeGreaterThan(100_000);
    expect(date).toBeLessThanOrEqual(120_000);
    expect(retryAfterMs('-5')).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });

  it('never reaches a vendor from tests without a mock transport', async () => {
    setMessagingTransport(null);
    const twilio = new TwilioProvider('sms', {
      accountSid: `AC${'0'.repeat(32)}`,
      authToken: 'x',
      from: '+15005550006',
    });
    expect((await rejection(twilio.send({ to: TO, body: 'x' }))).code).toBe('LIVE_CALLS_DISABLED');
    const smtp = new SmtpProvider('email', { host: 'smtp.example.test', port: '587', from: 'a@apex.test' });
    expect((await rejection(smtp.send({ to: 'a@apex.test', body: 'x' }))).code).toBe('LIVE_CALLS_DISABLED');
  });

  it('builds adapters by kind', () => {
    expect(createMessagingProvider('msg91', 'sms', {}).name).toBe('msg91');
    expect(createMessagingProvider('whatsapp-cloud', 'whatsapp', {}).requiresOptIn).toBe(true);
    expect(createMessagingProvider('twilio', 'whatsapp', { requireOptIn: 'no' }).requiresOptIn).toBe(false);
    expect(createMessagingProvider('twilio', 'sms', {}).requiresOptIn).toBe(false);
    expect(() => createMessagingProvider('pigeon', 'sms')).toThrow(/Unknown messaging provider/);
  });
});

describe('MSG91', () => {
  const MSG91 = { authKey: 'msg91-auth-key', senderId: 'APEXED', dltEntityId: '1201159100000000001' };
  const DLT_TEMPLATE = '1207161234567890123';
  const FLOW_TEMPLATE = '64a1b2c3d4e5f60718293a4b';
  const ok = { body: { type: 'success', message: '3763646c3058373530393138' } };

  it('sends DLT text SMS with the template and entity ids', async () => {
    const t = mockTransport({ http: () => ok });
    const result = await new Msg91Provider('sms', MSG91).send({
      to: TO,
      body: 'Received Rs 500. Receipt R-1',
      templateId: DLT_TEMPLATE,
    });
    expect(result).toEqual({ providerMessageId: '3763646c3058373530393138', status: 'sent' });
    const url = new URL(t.http[0].url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.msg91.com/api/sendhttp.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      authkey: 'msg91-auth-key',
      mobiles: '919510000001',
      message: 'Received Rs 500. Receipt R-1',
      sender: 'APEXED',
      route: '4',
      response: 'json',
      DLT_TE_ID: DLT_TEMPLATE,
      PE_ID: '1201159100000000001',
    });
  });

  it('sends MSG91 templates through the Flow API with named and positional variables', async () => {
    expect(isDltTemplateId(DLT_TEMPLATE)).toBe(true);
    expect(isDltTemplateId(FLOW_TEMPLATE)).toBe(false);
    const t = mockTransport({ http: () => ok });
    await new Msg91Provider('sms', MSG91).send({
      to: TO,
      body: 'ignored',
      templateId: FLOW_TEMPLATE,
      variables: [
        { name: 'amount', value: '500' },
        { name: 'student.name', value: 'Asha' },
      ],
    });
    expect(t.http[0].url).toBe('https://control.msg91.com/api/v5/flow');
    expect(t.http[0].headers.authkey).toBe('msg91-auth-key');
    expect(json(t.http[0])).toEqual({
      template_id: FLOW_TEMPLATE,
      short_url: '0',
      recipients: [
        {
          mobiles: '919510000001',
          amount: '500',
          AMOUNT: '500',
          VAR1: '500',
          var1: '500',
          student_name: 'Asha',
          STUDENT_NAME: 'Asha',
          name: 'Asha',
          VAR2: 'Asha',
          var2: 'Asha',
        },
      ],
    });
    expect(flowVariables([])).toEqual({});
  });

  it('sends the login OTP with the platform OTP template only', async () => {
    const t = mockTransport({ http: () => ok });
    const missing = await rejection(new Msg91Provider('sms', MSG91).send(otpSms(TO, '123456', 300)));
    expect(missing.code).toBe('TEMPLATE_REQUIRED');
    expect(t.http).toHaveLength(0);

    await new Msg91Provider('sms', { ...MSG91, otpTemplateId: DLT_TEMPLATE }).send(otpSms(TO, '123456', 300));
    expect(new URL(t.http[0].url).searchParams.get('message')).toBe(
      '123456 is your verification code. It expires in 5 minutes.',
    );
    expect(new URL(t.http[0].url).searchParams.get('DLT_TE_ID')).toBe(DLT_TEMPLATE);

    await new Msg91Provider('sms', { ...MSG91, otpTemplateId: FLOW_TEMPLATE }).send(
      otpSms(TO, '654321', 600),
    );
    expect(json(t.http[1]).recipients[0]).toMatchObject({ otp: '654321', OTP: '654321', minutes: '10' });
  });

  it('classifies MSG91 errors without leaking the auth key', async () => {
    mockTransport({
      http: () => ({ body: { type: 'error', message: 'Authentication failure', code: '418' } }),
    });
    const rejected = await rejection(new Msg91Provider('sms', MSG91).send({ to: TO, body: 'x' }));
    expect(rejected).toMatchObject({ code: 'MSG91_418', transient: false });
    expect(rejected.message).toContain('Authentication failure');

    mockTransport({ http: () => ({ status: 503, body: 'busy', headers: { 'retry-after': '120' } }) });
    expect(await rejection(new Msg91Provider('sms', MSG91).send({ to: TO, body: 'x' }))).toMatchObject({
      code: 'HTTP_503',
      transient: true,
      retryAfterMs: 120_000,
    });

    mockTransport({
      http: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
    });
    const network = await rejection(new Msg91Provider('sms', MSG91).send({ to: TO, body: 'x' }));
    expect(network).toMatchObject({ code: 'NETWORK', transient: true });
    expect(network.message).toBe('MSG91 could not be reached (ECONNRESET)');
    expect(network.message).not.toContain('msg91-auth-key');
  });

  it('sends WhatsApp templates with a document header from the integrated number', async () => {
    const t = mockTransport({
      http: () => ({ body: { status: 'success', hasError: false, request_id: 'req-wa-1' } }),
    });
    const wa = new Msg91Provider('whatsapp', {
      authKey: 'msg91-auth-key',
      integratedNumber: '+91 95100 00099',
    });
    expect(wa.requiresOptIn).toBe(true);
    const result = await wa.send({
      to: TO,
      body: 'ignored',
      templateId: 'fee_receipt:en',
      variables: [{ name: 'amount', value: '500' }],
      document: PDF,
    });
    expect(result.providerMessageId).toBe('req-wa-1');
    expect(t.http[0].url).toBe('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/');
    expect(json(t.http[0])).toEqual({
      integrated_number: '919510000099',
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: 'fee_receipt',
          language: { code: 'en', policy: 'deterministic' },
          namespace: null,
          to_and_components: [
            {
              to: ['919510000001'],
              components: {
                header_1: { type: 'document', value: PDF.url, filename: PDF.filename },
                body_1: { type: 'text', value: '500' },
              },
            },
          ],
        },
      },
    });
    expect((await rejection(wa.send({ to: TO, body: 'free text' }))).code).toBe('TEMPLATE_REQUIRED');
  });

  it('checks the auth key with a balance lookup', async () => {
    const t = mockTransport({ http: () => ({ body: '1520.50' }) });
    expect(await new Msg91Provider('sms', MSG91).verify()).toBe(
      'MSG91 accepted the auth key (balance 1520.50)',
    );
    expect(new URL(t.http[0].url).pathname).toBe('/api/balance.php');
    mockTransport({ http: () => ({ body: { msg: 'Authentication failure', msgType: 'error' } }) });
    expect((await rejection(new Msg91Provider('sms', MSG91).verify())).message).toBe(
      'MSG91 rejected the auth key: Authentication failure',
    );
  });
});

describe('Twilio', () => {
  const TWILIO = {
    accountSid: `AC${'0123456789abcdef'.repeat(2)}`,
    authToken: 'twilio-auth-token',
    from: '+15005550006',
  };
  const STATUS_URL = 'https://api.apex.test/api/notifications/public/webhooks/twilio/key-123456';
  const created = { status: 201, body: { sid: `SM${'a'.repeat(32)}`, status: 'queued' } };

  it('sends SMS with basic auth and the status callback', async () => {
    const t = mockTransport({ http: () => created });
    const result = await new TwilioProvider('sms', TWILIO, { webhookUrl: STATUS_URL }).send({
      to: TO,
      body: 'Hello',
      document: PDF,
    });
    expect(result).toEqual({ providerMessageId: `SM${'a'.repeat(32)}`, status: 'sent' });
    expect(t.http[0].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json`,
    );
    expect(t.http[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${TWILIO.accountSid}:twilio-auth-token`).toString('base64')}`,
    );
    // SMS keeps the text alone (MMS is US/Canada only).
    expect(form(t.http[0])).toEqual({
      To: '+919510000001',
      From: '+15005550006',
      Body: 'Hello',
      StatusCallback: STATUS_URL,
    });
  });

  it('sends through a Messaging Service, and WhatsApp with Content templates or media', async () => {
    const t = mockTransport({ http: () => created });
    const service = `MG${'1'.repeat(32)}`;
    await new TwilioProvider('sms', { ...TWILIO, from: service }).send({ to: TO, body: 'Hi' });
    expect(form(t.http[0])).toMatchObject({ MessagingServiceSid: service });
    expect(form(t.http[0]).From).toBeUndefined();

    const wa = new TwilioProvider('whatsapp', { ...TWILIO, from: '+14155238886' });
    expect(wa.requiresOptIn).toBe(true);
    await wa.send({
      to: TO,
      body: 'ignored',
      templateId: `HX${'b'.repeat(32)}`,
      variables: [
        { name: 'amount', value: '500' },
        { name: 'receiptNo', value: 'R-1' },
      ],
    });
    expect(form(t.http[1])).toEqual({
      To: 'whatsapp:+919510000001',
      From: 'whatsapp:+14155238886',
      ContentSid: `HX${'b'.repeat(32)}`,
      ContentVariables: '{"1":"500","2":"R-1"}',
    });
    await wa.send({ to: TO, body: 'Your receipt', document: PDF });
    expect(form(t.http[2])).toMatchObject({ Body: 'Your receipt', MediaUrl: PDF.url });
  });

  it('retries rate limits but not rejected numbers', async () => {
    mockTransport({
      http: () => ({
        status: 400,
        body: { code: 21211, message: "The 'To' number 951 is not a valid phone number.", status: 400 },
      }),
    });
    expect(await rejection(new TwilioProvider('sms', TWILIO).send({ to: '951', body: 'x' }))).toMatchObject({
      code: 'TWILIO_21211',
      transient: false,
    });
    mockTransport({
      http: () => ({
        status: 429,
        body: { code: 20429, message: 'Too Many Requests' },
        headers: { 'retry-after': '30' },
      }),
    });
    expect(await rejection(new TwilioProvider('sms', TWILIO).send({ to: TO, body: 'x' }))).toMatchObject({
      code: 'TWILIO_20429',
      transient: true,
      retryAfterMs: 30_000,
    });
  });

  it('checks live and test credentials without sending', async () => {
    const t = mockTransport({ http: () => ({ body: { friendly_name: 'Apex Classes', status: 'active' } }) });
    expect(await new TwilioProvider('sms', TWILIO).verify()).toBe(
      'Twilio accepted the credentials (account "Apex Classes", active)',
    );
    expect(t.http[0]).toMatchObject({
      method: 'GET',
      url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO.accountSid}.json`,
    });
    mockTransport({
      http: () => ({
        status: 403,
        body: { code: 20008, message: 'Resource not accessible with Test Account Credentials' },
      }),
    });
    expect(await new TwilioProvider('sms', TWILIO).verify()).toContain('test credentials');
    mockTransport({ http: () => ({ status: 401, body: { code: 20003, message: 'Authenticate' } }) });
    expect((await rejection(new TwilioProvider('sms', TWILIO).verify())).code).toBe('TWILIO_20003');
  });

  it('rejects a malformed Account SID before calling Twilio', async () => {
    const t = mockTransport({ http: () => created });
    const err = await rejection(
      new TwilioProvider('sms', { ...TWILIO, accountSid: 'AC-platform-1' }).send({ to: TO, body: 'x' }),
    );
    expect(err.code).toBe('INVALID_SETTINGS');
    expect(t.http).toHaveLength(0);
  });
});

describe('WhatsApp Cloud API', () => {
  const META = {
    phoneNumberId: '106540352242922',
    accessToken: 'meta-access-token',
    appSecret: 'meta-app-secret',
  };
  const accepted = {
    body: {
      messaging_product: 'whatsapp',
      contacts: [{ input: '919510000001', wa_id: '919510000001' }],
      messages: [{ id: 'wamid.HBgMOTE5NTEwMDAwMDAx' }],
    },
  };

  it('sends approved templates with a document header and body parameters', async () => {
    const t = mockTransport({ http: () => accepted });
    const wa = new WhatsAppCloudProvider('whatsapp', { ...META, defaultLanguage: 'hi' });
    const result = await wa.send({
      to: TO,
      body: 'ignored',
      templateId: 'fee_receipt',
      variables: [
        { name: 'amount', value: '500' },
        { name: 'note', value: 'line one\nline two' },
        { name: 'empty', value: '' },
      ],
      document: PDF,
    });
    expect(result).toEqual({ providerMessageId: 'wamid.HBgMOTE5NTEwMDAwMDAx', status: 'sent' });
    expect(t.http[0].url).toBe('https://graph.facebook.com/v27.0/106540352242922/messages');
    expect(t.http[0].headers.authorization).toBe('Bearer meta-access-token');
    expect(json(t.http[0])).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919510000001',
      type: 'template',
      template: {
        name: 'fee_receipt',
        language: { code: 'hi' },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'document', document: { link: PDF.url, filename: PDF.filename } }],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '500' },
              { type: 'text', text: 'line one line two' },
              { type: 'text', text: '-' },
            ],
          },
        ],
      },
    });
  });

  it('sends free text and documents inside the customer service window', async () => {
    const t = mockTransport({ http: () => accepted });
    const wa = new WhatsAppCloudProvider('whatsapp', { ...META, apiVersion: 'v21.0' });
    await wa.send({ to: '+447700900123', body: 'Hello' });
    expect(t.http[0].url).toBe('https://graph.facebook.com/v21.0/106540352242922/messages');
    expect(json(t.http[0])).toMatchObject({
      to: '447700900123',
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
    await wa.send({ to: TO, body: 'Your receipt', document: PDF });
    expect(json(t.http[1])).toMatchObject({
      type: 'document',
      document: { link: PDF.url, filename: PDF.filename, caption: 'Your receipt' },
    });
  });

  it('classifies Graph API errors', async () => {
    mockTransport({
      http: () => ({
        status: 400,
        body: {
          error: {
            message: '(#131030) Recipient phone number not in allowed list',
            type: 'OAuthException',
            code: 131030,
            error_data: {
              messaging_product: 'whatsapp',
              details: 'Recipient phone number not in allowed list',
            },
          },
        },
      }),
    });
    const wa = new WhatsAppCloudProvider('whatsapp', META);
    const notAllowed = await rejection(wa.send({ to: TO, body: 'x' }));
    expect(notAllowed).toMatchObject({ code: 'WHATSAPP_131030', transient: false });
    expect(notAllowed.message).toContain('Recipient phone number not in allowed list');
    mockTransport({
      http: () => ({ status: 400, body: { error: { code: 130429, message: 'Rate limit hit' } } }),
    });
    expect(await rejection(wa.send({ to: TO, body: 'x' }))).toMatchObject({
      code: 'WHATSAPP_130429',
      transient: true,
    });
    mockTransport({
      http: () => ({ status: 401, body: { error: { code: 190, message: 'Invalid OAuth access token' } } }),
    });
    expect(await rejection(wa.send({ to: TO, body: 'x' }))).toMatchObject({
      code: 'WHATSAPP_190',
      transient: false,
    });
  });

  it('validates settings and checks the token by reading the phone number', async () => {
    const t = mockTransport({
      http: () => ({ body: { display_phone_number: '+91 95100 00099', verified_name: 'Apex Classes' } }),
    });
    expect(await new WhatsAppCloudProvider('whatsapp', META).verify()).toBe(
      'WhatsApp accepted the access token for +91 95100 00099 (Apex Classes)',
    );
    expect(t.http[0]).toMatchObject({
      method: 'GET',
      url: 'https://graph.facebook.com/v27.0/106540352242922?fields=display_phone_number,verified_name',
    });
    const badVersion = new WhatsAppCloudProvider('whatsapp', { ...META, apiVersion: 'latest' });
    expect((await rejection(badVersion.send({ to: TO, body: 'x' }))).code).toBe('INVALID_SETTINGS');
    const badId = new WhatsAppCloudProvider('whatsapp', { ...META, phoneNumberId: '../me' });
    expect((await rejection(badId.verify())).code).toBe('INVALID_SETTINGS');
    expect((await rejection(new WhatsAppCloudProvider('sms', META).send({ to: TO, body: 'x' }))).code).toBe(
      'UNSUPPORTED_CHANNEL',
    );
  });
});

describe('SMTP', () => {
  const SMTP = {
    host: 'smtp.example.test',
    port: '587',
    user: 'apikey',
    password: 'smtp-password',
    from: 'Apex Classes <noreply@apex.test>',
  };

  it('sends over STARTTLS with the attachment as a link nodemailer downloads', async () => {
    const t = mockTransport({});
    const result = await new SmtpProvider('email', SMTP).send({
      to: 'parent@apex.test',
      subject: 'Fee receipt',
      body: 'Thank you',
      document: PDF,
    });
    expect(result).toEqual({ providerMessageId: '<msg-1@apex.test>', status: 'sent' });
    expect(t.smtp[0]).toMatchObject({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'apikey', pass: 'smtp-password' },
      disableFileAccess: true,
    });
    expect(t.mail[0]).toEqual({
      from: 'Apex Classes <noreply@apex.test>',
      to: 'parent@apex.test',
      subject: 'Fee receipt',
      text: 'Thank you',
      attachments: [{ filename: PDF.filename, path: PDF.url }],
    });
    expect(t.closed()).toBe(1);
  });

  it('uses implicit TLS on 465 and plain SMTP only when TLS is turned off', async () => {
    const t = mockTransport({});
    await new SmtpProvider('email', { ...SMTP, port: '465' }).send({ to: 'a@apex.test', body: 'x' });
    expect(t.smtp[0]).toMatchObject({ port: 465, secure: true, requireTLS: false });
    await new SmtpProvider('email', { ...SMTP, port: '25', secure: 'false', user: '' }).send({
      to: 'a@apex.test',
      body: 'x',
    });
    expect(t.smtp[1]).toMatchObject({ port: 25, secure: false, requireTLS: false, auth: undefined });
    expect(
      (
        await rejection(
          new SmtpProvider('email', { ...SMTP, port: 'abc' }).send({ to: 'a@apex.test', body: 'x' }),
        )
      ).code,
    ).toBe('INVALID_SETTINGS');
  });

  it('retries temporary SMTP failures only', async () => {
    const failWith = (error: object) =>
      mockTransport({
        mailer: {
          sendMail: async () => {
            throw Object.assign(new Error('smtp error'), error);
          },
        },
      });
    const send = () => new SmtpProvider('email', SMTP).send({ to: 'a@apex.test', body: 'x' });
    failWith({ code: 'EAUTH', responseCode: 535, response: '535 Authentication failed' });
    expect(await rejection(send())).toMatchObject({ code: 'SMTP_EAUTH', transient: false });
    failWith({ code: 'EENVELOPE', responseCode: 550, response: '550 5.1.1 User unknown' });
    expect(await rejection(send())).toMatchObject({ code: 'SMTP_EENVELOPE', transient: false });
    failWith({ code: 'EMESSAGE', responseCode: 421, response: '421 Try again later' });
    expect(await rejection(send())).toMatchObject({ transient: true });
    failWith({ code: 'ECONNECTION' });
    expect(await rejection(send())).toMatchObject({ code: 'SMTP_ECONNECTION', transient: true });
    mockTransport({
      mailer: { sendMail: async () => ({ messageId: 'x', accepted: [], rejected: ['a@apex.test'] }) },
    });
    expect(await rejection(send())).toMatchObject({ code: 'SMTP_REJECTED', transient: false });
  });

  it('checks the login without sending', async () => {
    const t = mockTransport({});
    expect(await new SmtpProvider('email', SMTP).verify()).toBe(
      'The SMTP server smtp.example.test:587 accepted the connection and login',
    );
    expect(t.mail).toHaveLength(0);
    mockTransport({
      mailer: {
        verify: async () => {
          throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
        },
      },
    });
    expect((await rejection(new SmtpProvider('email', SMTP).verify())).code).toBe('SMTP_EAUTH');
  });
});

describe('FCM and APNs push', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const EC_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let accounts = 0;
  /** A distinct service account per test: access tokens are cached per credential. */
  const fcm = (extra: Record<string, string> = {}) => ({
    projectId: 'apex-erp-test',
    clientEmail: `push-${++accounts}@apex-erp-test.iam.gserviceaccount.com`,
    // As pasted from the service account JSON, with literal \n.
    privateKey: RSA_PEM.replace(/\n/g, '\\n'),
    ...extra,
  });
  const APNS = {
    apnsKeyId: 'ABC123DEFG',
    apnsTeamId: 'DEF123GHIJ',
    apnsBundleId: 'com.erpcoaching.app',
    apnsPrivateKey: EC_PEM,
  };
  const ANDROID = 'fcm-android-device-1';
  const IOS = 'a1b2'.repeat(16);
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const SEND_URL = 'https://fcm.googleapis.com/v1/projects/apex-erp-test/messages:send';
  const googleToken = {
    body: { access_token: 'ya29.test-access-token', expires_in: 3599, token_type: 'Bearer' },
  };
  const fcmReply = (send: HttpReply) => (call: HttpCall) => (call.url === TOKEN_URL ? googleToken : send);
  const fcmError = (status: number, errorStatus: string, message: string, errorCode?: string) => ({
    status,
    body: {
      error: {
        code: status,
        message,
        status: errorStatus,
        details: errorCode
          ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }]
          : [],
      },
    },
  });

  it('signs in with the service account once and sends to Android tokens', async () => {
    const t = mockTransport({
      http: fcmReply({ body: { name: 'projects/apex-erp-test/messages/0:1700%abc' } }),
    });
    const provider = new FcmProvider('push', fcm());
    const result = await provider.send({
      to: ANDROID,
      subject: 'Homework',
      body: 'Maths homework',
      data: { messageId: 7, eventKey: 'homework.assigned', from: 'x', extra: { a: 1 }, none: null },
    });
    expect(result).toEqual({ providerMessageId: '0:1700%abc', status: 'sent' });

    const grant = form(t.http[0]);
    expect(t.http[0].url).toBe(TOKEN_URL);
    expect(grant.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = decodeJwt(grant.assertion);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(jwt.claims).toMatchObject({
      iss: `push-${accounts}@apex-erp-test.iam.gserviceaccount.com`,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: TOKEN_URL,
    });
    expect(Number(jwt.claims.exp) - Number(jwt.claims.iat)).toBe(3600);
    expect(crypto.verify('sha256', jwt.signed, rsa.publicKey, jwt.signature)).toBe(true);

    expect(t.http[1].url).toBe(SEND_URL);
    expect(t.http[1].headers.authorization).toBe('Bearer ya29.test-access-token');
    expect(json(t.http[1]).message).toMatchObject({
      token: ANDROID,
      notification: { title: 'Homework', body: 'Maths homework' },
      data: { messageId: '7', eventKey: 'homework.assigned', extra: '{"a":1}' },
      android: { priority: 'high' },
    });
    expect(pushData({ from: 'x', google_x: 'y', aps: 'z', ok: true })).toEqual({ ok: 'true' });

    await provider.send({ to: ANDROID, body: 'Again' });
    expect(t.http.map((c) => c.url)).toEqual([TOKEN_URL, SEND_URL, SEND_URL]);
  });

  it('marks uninstalled devices as invalid recipients', async () => {
    for (const reply of [
      fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED'),
      fcmError(
        400,
        'INVALID_ARGUMENT',
        'The registration token is not a valid FCM registration token',
        'INVALID_ARGUMENT',
      ),
    ]) {
      mockTransport({ http: fcmReply(reply) });
      expect(await rejection(new FcmProvider('push', fcm()).send({ to: ANDROID, body: 'x' }))).toMatchObject({
        invalidRecipient: true,
        transient: false,
      });
    }
    mockTransport({ http: fcmReply(fcmError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.')) });
    expect(await rejection(new FcmProvider('push', fcm()).send({ to: ANDROID, body: 'x' }))).toMatchObject({
      code: 'FCM_INVALID_ARGUMENT',
      invalidRecipient: false,
      transient: false,
    });
  });

  it('retries outages and refreshes an expired access token', async () => {
    mockTransport({
      http: fcmReply({
        ...fcmError(503, 'UNAVAILABLE', 'The service is unavailable.', 'UNAVAILABLE'),
        headers: { 'retry-after': '10' },
      }),
    });
    expect(await rejection(new FcmProvider('push', fcm()).send({ to: ANDROID, body: 'x' }))).toMatchObject({
      code: 'FCM_UNAVAILABLE',
      transient: true,
      retryAfterMs: 10_000,
    });

    const settings = fcm();
    const t = mockTransport({
      http: fcmReply(fcmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.')),
    });
    expect(await rejection(new FcmProvider('push', settings).send({ to: ANDROID, body: 'x' }))).toMatchObject(
      {
        transient: true,
      },
    );
    await rejection(new FcmProvider('push', settings).send({ to: ANDROID, body: 'x' }));
    expect(t.http.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);

    mockTransport({
      http: fcmReply(
        fcmError(
          401,
          'UNAUTHENTICATED',
          'Auth error from APNS or Web Push Service',
          'THIRD_PARTY_AUTH_ERROR',
        ),
      ),
    });
    expect(await rejection(new FcmProvider('push', fcm()).send({ to: ANDROID, body: 'x' }))).toMatchObject({
      code: 'FCM_THIRD_PARTY_AUTH_ERROR',
      transient: false,
    });
  });

  it('reports a rejected service account or key', async () => {
    mockTransport({
      http: () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
      }),
    });
    const auth = await rejection(new FcmProvider('push', fcm()).send({ to: ANDROID, body: 'x' }));
    expect(auth).toMatchObject({ code: 'FCM_AUTH', transient: false });
    expect(auth.message).toBe('Google rejected the service account: Invalid JWT Signature.');
    const t = mockTransport({ http: () => googleToken });
    expect(
      (
        await rejection(
          new FcmProvider('push', fcm({ privateKey: 'not a key' })).send({ to: ANDROID, body: 'x' }),
        )
      ).code,
    ).toBe('INVALID_SETTINGS');
    expect(
      (await rejection(new FcmProvider('push', fcm({ privateKey: EC_PEM })).send({ to: ANDROID, body: 'x' })))
        .message,
    ).toContain('is not an RSA key');
    expect(
      (
        await rejection(
          new FcmProvider('push', fcm({ projectId: 'Apex/../x' })).send({ to: ANDROID, body: 'x' }),
        )
      ).code,
    ).toBe('INVALID_SETTINGS');
    expect(t.http).toHaveLength(0);
  });

  it('sends iOS tokens to APNs with an ES256 provider token', async () => {
    expect(isApnsToken(IOS)).toBe(true);
    expect(isApnsToken(ANDROID)).toBe(false);
    const t = mockTransport({ h2: () => ({ status: 200, headers: { 'apns-id': 'apns-uuid-1' }, body: '' }) });
    const result = await new FcmProvider('push', fcm(APNS)).send({
      to: IOS,
      subject: 'Fee receipt',
      body: 'Received Rs 500',
      data: { messageId: 9 },
    });
    expect(result).toEqual({ providerMessageId: 'apns-uuid-1', status: 'sent' });
    expect(t.http).toHaveLength(0);
    expect(t.h2[0]).toMatchObject({ origin: 'https://api.push.apple.com', path: `/3/device/${IOS}` });
    expect(t.h2[0].headers).toMatchObject({
      'apns-topic': 'com.erpcoaching.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
    });
    expect(JSON.parse(t.h2[0].body)).toEqual({
      aps: { alert: { title: 'Fee receipt', body: 'Received Rs 500' }, sound: 'default' },
      messageId: '9',
    });
    const jwt = decodeJwt(t.h2[0].headers.authorization.replace(/^bearer /, ''));
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(jwt.claims.iss).toBe('DEF123GHIJ');
    expect(
      crypto.verify('sha256', jwt.signed, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature),
    ).toBe(true);
  });

  it('tries the other APNs environment for development tokens, then drops dead tokens', async () => {
    const t = mockTransport({
      h2: (c) =>
        c.origin === 'https://api.push.apple.com'
          ? { status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' }
          : { status: 200, headers: { 'apns-id': 'sandbox-1' }, body: '' },
    });
    expect((await new FcmProvider('push', fcm(APNS)).send({ to: IOS, body: 'x' })).providerMessageId).toBe(
      'sandbox-1',
    );
    expect(t.h2.map((c) => c.origin)).toEqual([
      'https://api.push.apple.com',
      'https://api.sandbox.push.apple.com',
    ]);

    const sandboxFirst = mockTransport({ h2: () => ({ status: 200, headers: {}, body: '' }) });
    await new FcmProvider('push', fcm({ ...APNS, apnsEnvironment: 'sandbox' })).send({ to: IOS, body: 'x' });
    expect(sandboxFirst.h2[0].origin).toBe('https://api.sandbox.push.apple.com');

    mockTransport({
      h2: () => ({ status: 410, headers: {}, body: '{"reason":"Unregistered","timestamp":1700000000000}' }),
    });
    expect(await rejection(new FcmProvider('push', fcm(APNS)).send({ to: IOS, body: 'x' }))).toMatchObject({
      code: 'APNS_Unregistered',
      invalidRecipient: true,
    });
    mockTransport({ h2: () => ({ status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' }) });
    expect(await rejection(new FcmProvider('push', fcm(APNS)).send({ to: IOS, body: 'x' }))).toMatchObject({
      invalidRecipient: true,
    });
  });

  it('classifies APNs failures', async () => {
    mockTransport({ h2: () => ({ status: 403, headers: {}, body: '{"reason":"InvalidProviderToken"}' }) });
    const key = await rejection(new FcmProvider('push', fcm(APNS)).send({ to: IOS, body: 'x' }));
    expect(key).toMatchObject({
      code: 'APNS_InvalidProviderToken',
      transient: false,
      invalidRecipient: false,
    });
    expect(key.message).toContain('check the key id, team id and .p8 key');
    mockTransport({ h2: () => ({ status: 503, headers: {}, body: '{"reason":"ServiceUnavailable"}' }) });
    expect(await rejection(new FcmProvider('push', fcm(APNS)).send({ to: IOS, body: 'x' }))).toMatchObject({
      transient: true,
    });
    mockTransport({ h2: () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    expect(await rejection(new FcmProvider('push', fcm(APNS)).send({ to: IOS, body: 'x' }))).toMatchObject({
      code: 'NETWORK',
      transient: true,
    });
    expect((await rejection(new FcmProvider('push', fcm()).send({ to: IOS, body: 'x' }))).code).toBe(
      'APNS_NOT_CONFIGURED',
    );
  });

  it('checks the Firebase and APNs keys without delivering anything', async () => {
    const t = mockTransport({
      http: fcmReply({ body: { name: 'projects/apex-erp-test/messages/fake' } }),
      h2: () => ({ status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' }),
    });
    expect(await new FcmProvider('push', fcm()).verify()).toBe(
      'Firebase accepted the service account for project apex-erp-test; APNs (iOS) is not configured',
    );
    expect(json(t.http[1])).toEqual({
      validate_only: true,
      message: { topic: 'erp-key-check', notification: { title: 'Key check', body: 'Key check' } },
    });
    expect(await new FcmProvider('push', fcm(APNS)).verify()).toBe(
      'Firebase accepted the service account for project apex-erp-test; APNs accepted the signing key (key ABC123DEFG, team DEF123GHIJ)',
    );
    expect(t.h2[0].path).toBe(`/3/device/${'0'.repeat(64)}`);
    mockTransport({
      http: fcmReply({ body: {} }),
      h2: () => ({ status: 403, headers: {}, body: '{"reason":"InvalidProviderToken"}' }),
    });
    expect((await rejection(new FcmProvider('push', fcm(APNS)).verify())).code).toBe(
      'APNS_InvalidProviderToken',
    );
  });
});
