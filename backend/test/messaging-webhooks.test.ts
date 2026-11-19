import crypto from 'node:crypto';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSequelize } from '../src/infrastructure/database/sequelize';
import { Job } from '../src/infrastructure/jobs/job.model';
import { processDueJobs } from '../src/infrastructure/jobs/queue';
import { setMessagingTransport, type Http2Response } from '../src/infrastructure/messaging';
import { runWithContext } from '../src/shared/context';
import { FileObject } from '../src/modules/files/file.model';
import { notify } from '../src/modules/notifications/api';
import {
  DeliveryAttempt,
  NotificationMessage,
  NotificationPreference,
  PushToken,
} from '../src/modules/notifications/models';
import { DELIVER_JOB } from '../src/modules/notifications/notify.service';
import { PlatformIntegration } from '../src/modules/platform/models';
import { invalidatePlatformIntegrations, loadIntegrations } from '../src/modules/platform/platform.service';
import { User } from '../src/modules/users/user.model';
import { bearer, getApp, login, newDevice, purgeRows, USERS } from './helpers';

/**
 * Vendor messaging end to end: provider settings → delivery through the real adapters → signed status
 * callbacks, consent replies and retries, for an institute and for the platform default (login OTPs).
 * The vendors' network is mocked at the adapter boundary: nothing here reaches a vendor.
 * 951… is this suite's mobile range.
 */

const RUN = Date.now().toString(36);
const STARTED_AT = new Date(Date.now() - 1000);
/** Raw-query replacements format Dates in the process's local zone; the DB stores UTC. */
const utc = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const hex = (bytes: number) => crypto.randomBytes(bytes).toString('hex');
const PASSWORD = 'Password@123';
const ADMIN_MOBILE = `951${String(crypto.randomInt(0, 10_000_000)).padStart(7, '0')}`;
const WA_ID = `91${ADMIN_MOBILE}`;
const PROVIDERS = '/api/notifications/providers';
const PLATFORM_SMS = '/api/admin/platform/messaging/sms';

const TWILIO = { accountSid: `AC${hex(16)}`, authToken: hex(16), from: '+15005550006' };
const PLATFORM_TWILIO = { accountSid: `AC${hex(16)}`, authToken: hex(16), from: '+15005550006' };
const META = { phoneNumberId: '106540352242922', accessToken: `EAAG${hex(20)}`, appSecret: hex(16) };
const MSG91 = { authKey: hex(12), senderId: 'APXEDU', dltEntityId: '1201159876543210987' };
const pem = (key: crypto.KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const FCM = {
  projectId: `erp-test-${RUN}`,
  clientEmail: `push-${RUN}@erp-test.iam.gserviceaccount.com`,
  privateKey: pem(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey),
  apnsKeyId: 'ABC123DEFG',
  apnsTeamId: 'DEF123GHIJ',
  apnsBundleId: 'com.example.erp',
  apnsPrivateKey: pem(crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey),
  apnsEnvironment: 'sandbox',
};
const RECEIPT = { amount: 500, student: { name: 'Asha' }, receiptNo: `R-${RUN}`, paidOn: '2026-01-01' };

// ------------------------------------------------------------------ mocked vendor network

interface HttpCall {
  url: URL;
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
type HttpReply = { status?: number; body?: unknown; headers?: Record<string, string> };

const calls: HttpCall[] = [];
const h2Calls: H2Call[] = [];
/** Per-test vendor failures; returning undefined falls through to the vendor's normal answer. */
let httpOverride: ((call: HttpCall) => HttpReply | undefined) | undefined;
let apnsOverride: ((call: H2Call) => Http2Response) | undefined;

function vendorReply(call: HttpCall): HttpReply {
  switch (call.url.hostname) {
    case 'api.twilio.com':
      return call.method === 'GET'
        ? { body: { friendly_name: 'ERP Test', status: 'active' } }
        : { status: 201, body: { sid: `SM${hex(16)}`, status: 'queued' } };
    case 'graph.facebook.com':
      return { body: { messaging_product: 'whatsapp', messages: [{ id: `wamid.${hex(8)}` }] } };
    case 'api.msg91.com':
      return { body: { type: 'success', message: hex(12) } };
    case 'oauth2.googleapis.com':
      return { body: { access_token: `ya29.${hex(16)}`, expires_in: 3599, token_type: 'Bearer' } };
    case 'fcm.googleapis.com':
      return { body: { name: `projects/${FCM.projectId}/messages/${hex(8)}` } };
    default:
      return { status: 404 };
  }
}

function mockVendors() {
  setMessagingTransport({
    fetch: async (url, init) => {
      const call: HttpCall = {
        url: new URL(url),
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === 'string' ? init.body : '',
      };
      calls.push(call);
      const reply = httpOverride?.(call) ?? vendorReply(call);
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
      return new Response(text, { status: reply.status ?? 200, headers: reply.headers });
    },
    http2Request: async (origin, path, headers, body) => {
      const call = { origin, path, headers, body };
      h2Calls.push(call);
      return apnsOverride?.(call) ?? { status: 200, headers: { 'apns-id': crypto.randomUUID() }, body: '' };
    },
    createMailer: () => {
      throw new Error('This suite sends no email');
    },
  });
}

function lastCall(host: string): HttpCall {
  const matching = calls.filter((c) => c.url.hostname === host);
  expect(matching.length, `requests to ${host}`).toBeGreaterThan(0);
  return matching[matching.length - 1];
}
const form = (call: HttpCall) => Object.fromEntries(new URLSearchParams(call.body));
const basicAuth = (c: { accountSid: string; authToken: string }) =>
  `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`;

// ------------------------------------------------------------------ API and records

let sa: string;
let T: { id: number; token: string };
let adminId: number;
let savedRows: Record<string, unknown>[] = [];

const asT = <R>(fn: () => Promise<R>) =>
  runWithContext({ system: true, instituteId: T.id, allowedBranchIds: null }, fn);

const send = async (method: 'put' | 'post' | 'delete', path: string, body?: object, token?: string) => {
  const req = request(await getApp())
    [method](path)
    .set(bearer(token ?? T.token));
  return body === undefined ? req : req.send(body);
};
const put = (path: string, body: object, token?: string) => send('put', path, body, token);
const post = (path: string, body: object, token?: string) => send('post', path, body, token);
const del = (path: string, token?: string) => send('delete', path, undefined, token);

const message = async (id: number) =>
  (await NotificationMessage.findOne({ where: { id, instituteId: T.id } }))?.get({ plain: true });
const attemptsOf = async (messageId: number) =>
  (
    await DeliveryAttempt.findAll({ where: { messageId, instituteId: T.id }, order: [['attemptNo', 'ASC']] })
  ).map((a) => a.get({ plain: true }));
const consentOf = async (channel: 'sms' | 'whatsapp') =>
  (
    await NotificationPreference.findOne({
      where: { instituteId: T.id, userId: adminId, channel, eventKey: '*' },
    })
  )?.get({ plain: true });

/** Sends a fee receipt to the institute admin on one channel and runs the delivery jobs. */
async function deliver(channel: 'sms' | 'whatsapp' | 'push', data: Record<string, unknown> = {}) {
  const result = await asT(() =>
    notify({
      event: 'fees.receipt',
      recipients: [{ userIds: [adminId], type: 'user' }],
      data: { ...RECEIPT, ...data },
      channels: [channel],
    }),
  );
  await processDueJobs();
  return result;
}

/** Makes this institute's pending deliveries due now (skips the backoff wait). */
const fastForward = () =>
  Job.update(
    { runAt: new Date(Date.now() - 1000) },
    { where: { name: DELIVER_JOB, status: 'pending', instituteId: T.id } },
  );

// ------------------------------------------------------------------ signed vendor webhooks

/** Twilio's request signature: base64 HMAC-SHA1 of the URL followed by the sorted POST parameters. */
const twilioSign = (url: string, params: Record<string, string>, authToken: string) =>
  crypto
    .createHmac('sha1', authToken)
    .update(
      url +
        Object.keys(params)
          .sort()
          .map((k) => k + params[k])
          .join(''),
    )
    .digest('base64');

async function twilioPost(url: string, params: Record<string, string>, authToken: string) {
  const { pathname, search } = new URL(url);
  return request(await getApp())
    .post(pathname + search)
    .type('form')
    .set('x-twilio-signature', twilioSign(url, params, authToken))
    .send(new URLSearchParams(params).toString());
}

const twilioStatus = (
  sid: string,
  status: string,
  account: { accountSid: string; from: string },
  extra: Record<string, string> = {},
) => ({
  AccountSid: account.accountSid,
  ApiVersion: '2010-04-01',
  From: account.from,
  MessageSid: sid,
  MessageStatus: status,
  SmsSid: sid,
  SmsStatus: status,
  To: `+${WA_ID}`,
  ...extra,
});

/** An incoming SMS (a reply to the institute's number). */
const twilioInbound = (body: string) => {
  const sid = `SM${hex(16)}`;
  return {
    AccountSid: TWILIO.accountSid,
    ApiVersion: '2010-04-01',
    Body: body,
    From: `+${WA_ID}`,
    MessageSid: sid,
    NumMedia: '0',
    NumSegments: '1',
    SmsMessageSid: sid,
    SmsSid: sid,
    SmsStatus: 'received',
    To: TWILIO.from,
  };
};

/** `X-Hub-Signature-256`: hex HMAC-SHA256 of the raw body with the Meta app secret. */
async function metaPost(url: string, raw: string, appSecret: string, contentType = 'application/json') {
  return request(await getApp())
    .post(new URL(url).pathname)
    .set('content-type', contentType)
    .set('x-hub-signature-256', `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`)
    .send(raw);
}

const metaEvent = (value: Record<string, unknown>) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: META.phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  });
const metaStatus = (id: string, status: string) =>
  metaEvent({ statuses: [{ id, status, timestamp: '1767225600', recipient_id: WA_ID }] });
const metaReply = (text: string) =>
  metaEvent({
    contacts: [{ profile: { name: 'Asha' }, wa_id: WA_ID }],
    messages: [
      { from: WA_ID, id: `wamid.${hex(8)}`, timestamp: '1767225600', type: 'text', text: { body: text } },
    ],
  });

// ------------------------------------------------------------------ setup

async function resetPlatformIntegrations(rows: Record<string, unknown>[]) {
  await PlatformIntegration.destroy({ where: {} });
  if (rows.length) await PlatformIntegration.bulkCreate(rows as never[]);
  invalidatePlatformIntegrations();
  await loadIntegrations(true);
}

beforeAll(async () => {
  sa = (await login(USERS.superAdmin)).accessToken;
  // No platform providers (login OTPs go through the console); whatever was there is restored afterwards.
  savedRows = (await PlatformIntegration.findAll({ raw: true })) as unknown as Record<string, unknown>[];
  await resetPlatformIntegrations([]);
  const [plan] = await getSequelize().query<{ id: number }>("SELECT id FROM plans WHERE code = 'starter'", {
    type: QueryTypes.SELECT,
  });
  const res = await post(
    '/api/admin/institutes',
    {
      name: 'Messaging Webhooks Test',
      slug: `mw-${RUN}`,
      planId: plan.id,
      state: 'Karnataka',
      admin: { name: 'Messaging Admin', mobile: ADMIN_MOBILE, password: PASSWORD },
    },
    sa,
  );
  expect(res.status).toBe(201);
  T = { id: res.body.id, token: (await login({ mobile: ADMIN_MOBILE, password: PASSWORD })).accessToken };
  adminId = (await User.findOne({ where: { mobile: ADMIN_MOBILE } }))!.id;
  // Whatever the new institute queued goes out through the console providers, before the vendors are mocked.
  await processDueJobs();
  mockVendors();
});

afterEach(() => {
  httpOverride = undefined;
  apnsOverride = undefined;
});

afterAll(async () => {
  setMessagingTransport(null);
  const sequelize = getSequelize();
  await resetPlatformIntegrations(savedRows);
  const select = async (sql: string, replacements: unknown[]) =>
    (await sequelize.query<{ id: number }>(sql, { replacements, type: QueryTypes.SELECT })).map((r) => r.id);
  if (T?.id) {
    await sequelize.query('DELETE FROM jobs WHERE institute_id = ?', { replacements: [T.id] });
    // Billing documents are kept when an institute is deleted (institute_id → NULL), so remove them first.
    await sequelize.query('DELETE FROM subscription_payments WHERE institute_id = ?', {
      replacements: [T.id],
    });
    await purgeRows(
      'subscription_invoices',
      await select('SELECT id FROM subscription_invoices WHERE institute_id = ?', [T.id]),
    );
    await sequelize.query('DELETE FROM audit_events WHERE institute_id = ?', { replacements: [T.id] });
    await purgeRows('institutes', [T.id]);
  }
  await sequelize.query('DELETE FROM otp_challenges WHERE mobile = ?', { replacements: [ADMIN_MOBILE] });
  await purgeRows('users', await select("SELECT id FROM users WHERE mobile LIKE '951%'", []));
  await sequelize.query(
    "DELETE FROM audit_events WHERE institute_id IS NULL AND created_at >= ? AND entity_type = 'platform_messaging'",
    { replacements: [utc(STARTED_AT)] },
  );
});

// ------------------------------------------------------------------ tests (in order: they share state)

describe('vendor messaging', () => {
  let twilioHook = '';
  let metaHook = '';
  let whatsappId = 0;
  let platformHook = '';

  it('sends SMS through Twilio and applies its signed status callbacks', async () => {
    const saved = await put(`${PROVIDERS}/sms`, {
      provider: 'twilio',
      isActive: true,
      settings: TWILIO,
      retryMaxAttempts: 3,
      retryBaseDelaySeconds: 5,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      provider: 'twilio',
      settings: { accountSid: TWILIO.accountSid, from: TWILIO.from },
      retryMaxAttempts: 3,
      retryBaseDelaySeconds: 5,
    });
    expect(JSON.stringify(saved.body)).not.toContain(TWILIO.authToken);
    twilioHook = saved.body.webhook.url;
    expect(twilioHook).toMatch(/\/api\/notifications\/public\/webhooks\/twilio\/[^/?]{10,80}$/);

    const sent = await deliver('sms');
    expect(sent).toMatchObject({ queued: 1, skipped: 0 });
    const call = lastCall('api.twilio.com');
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe(`/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json`);
    expect(call.headers.authorization).toBe(basicAuth(TWILIO));
    expect(form(call)).toMatchObject({ To: `+${WA_ID}`, From: TWILIO.from, StatusCallback: twilioHook });
    expect(form(call).Body).toContain(`Receipt R-${RUN}`);
    const id = sent.messageIds[0];
    expect(await message(id)).toMatchObject({ status: 'sent', provider: 'twilio', attempts: 1 });
    const sid = (await message(id))!.providerMessageId!;
    expect(sid).toMatch(/^SM[0-9a-f]{32}$/);

    const delivered = twilioStatus(sid, 'delivered', TWILIO);
    const forged = await twilioPost(twilioHook, delivered, hex(16));
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await message(id))!.status).toBe('sent');

    const res = await twilioPost(twilioHook, delivered, TWILIO.authToken);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(res.text).toBe('<Response></Response>');
    expect(await message(id)).toMatchObject({ status: 'delivered', deliveredAt: expect.any(Date) });
    expect(await attemptsOf(id)).toMatchObject([
      { attemptNo: 1, status: 'delivered', providerMessageId: sid },
    ]);

    // Callbacks arrive out of order: a late "sent" does not undo "delivered".
    expect((await twilioPost(twilioHook, twilioStatus(sid, 'sent', TWILIO), TWILIO.authToken)).status).toBe(
      200,
    );
    expect((await message(id))!.status).toBe('delivered');
    expect(
      (await twilioPost(twilioHook.replace(/[^/]+$/, hex(16)), delivered, TWILIO.authToken)).status,
    ).toBe(404);

    // The settings page's key check and test message.
    const check = await post(`${PROVIDERS}/sms/verify`, {});
    expect(check.body).toMatchObject({ ok: true, provider: 'twilio' });
    expect(check.body.message).toContain('ERP Test');
    expect(lastCall('api.twilio.com').method).toBe('GET');
    expect(lastCall('api.twilio.com').url.pathname).toBe(`/2010-04-01/Accounts/${TWILIO.accountSid}.json`);
    const test = await post(`${PROVIDERS}/sms/test`, { to: ADMIN_MOBILE, body: 'Messaging test' });
    expect(test.body).toMatchObject({
      ok: true,
      provider: 'twilio',
      providerMessageId: expect.stringMatching(/^SM/),
    });
    expect(form(lastCall('api.twilio.com')).Body).toContain('Messaging test');
  });

  it('retries transient vendor errors with backoff and stops at a permanent one', async () => {
    httpOverride = (call) =>
      call.url.hostname === 'api.twilio.com'
        ? {
            status: 429,
            headers: { 'retry-after': '120' },
            body: { code: 20429, message: 'Too Many Requests', status: 429 },
          }
        : undefined;
    const startedAt = Date.now();
    const {
      messageIds: [id],
    } = await deliver('sms');
    const queued = await message(id);
    expect(queued).toMatchObject({ status: 'queued', attempts: 1, maxAttempts: 3 });
    // Twilio's Retry-After (120 s) outweighs the 5 s backoff base.
    const wait = queued!.nextAttemptAt!.getTime() - startedAt;
    expect(wait).toBeGreaterThan(115_000);
    expect(wait).toBeLessThan(135_000);
    expect(await attemptsOf(id)).toMatchObject([{ attemptNo: 1, status: 'failed' }]);

    await processDueJobs(); // not due yet
    expect((await message(id))!.attempts).toBe(1);

    httpOverride = (call) =>
      call.url.hostname === 'api.twilio.com'
        ? {
            status: 400,
            body: { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 },
          }
        : undefined;
    await fastForward();
    await processDueJobs();
    const failed = await message(id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 2 });
    expect(failed!.lastError).toBeTruthy();
    expect(failed!.lastError).not.toContain(TWILIO.authToken);
    expect(await attemptsOf(id)).toMatchObject([
      { attemptNo: 1, status: 'failed' },
      { attemptNo: 2, status: 'failed' },
    ]);
    // A permanent error is final: nothing is left to retry.
    expect(await Job.count({ where: { name: DELIVER_JOB, status: 'pending', instituteId: T.id } })).toBe(0);
  });

  it('turns SMS off and back on with STOP and START replies', async () => {
    expect((await twilioPost(twilioHook, twilioInbound('STOP'), TWILIO.authToken)).status).toBe(200);
    expect(await consentOf('sms')).toMatchObject({ enabled: false, source: 'sms-stop' });
    const stopped = await deliver('sms');
    expect(stopped).toMatchObject({ queued: 0, skipped: 1 });
    expect(await message(stopped.messageIds[0])).toMatchObject({
      status: 'skipped',
      lastError: 'Recipient opted out',
    });

    expect((await twilioPost(twilioHook, twilioInbound('Start'), TWILIO.authToken)).status).toBe(200);
    expect(await consentOf('sms')).toMatchObject({ enabled: true, source: 'sms-start' });
    const [audits] = await getSequelize().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit_events WHERE institute_id = ? AND action = 'notifications.consent_keyword'",
      { replacements: [T.id], type: QueryTypes.SELECT },
    );
    expect(Number(audits.n)).toBe(2);
  });

  it('answers the WhatsApp Cloud webhook verification handshake', async () => {
    const saved = await put(`${PROVIDERS}/whatsapp`, {
      provider: 'whatsapp-cloud',
      isActive: true,
      settings: META,
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(META.accessToken);
    expect(JSON.stringify(saved.body)).not.toContain(META.appSecret);
    const { url, verifyToken } = saved.body.webhook as { url: string; verifyToken: string };
    expect(url).toMatch(/\/api\/notifications\/public\/webhooks\/whatsapp-cloud\/[^/?]{10,80}$/);
    expect(verifyToken).toMatch(/^[0-9a-f]{32}$/);
    metaHook = url;

    const handshake = async (token: string, path = new URL(url).pathname) =>
      request(await getApp())
        .get(path)
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' });
    const ok = await handshake(verifyToken);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect((await handshake('not-the-verify-token')).status).toBe(403);
    expect((await handshake(verifyToken, new URL(url).pathname.replace(/[^/]+$/, hex(16)))).status).toBe(404);
  });

  it('sends WhatsApp templates with the PDF receipt, only after the user opts in', async () => {
    const before = await deliver('whatsapp');
    expect(before).toMatchObject({ queued: 0, skipped: 1 });
    expect(await message(before.messageIds[0])).toMatchObject({
      status: 'skipped',
      lastError: 'No WhatsApp opt-in',
    });

    const optIn = await metaPost(metaHook, metaReply('START'), META.appSecret);
    expect(optIn.status).toBe(200);
    expect(optIn.body).toMatchObject({ received: true, consent: 1 });
    // Meta redelivers webhooks: the same reply changes nothing the second time.
    expect((await metaPost(metaHook, metaReply('START'), META.appSecret)).body).toMatchObject({ consent: 0 });
    expect(await consentOf('whatsapp')).toMatchObject({ enabled: true, source: 'whatsapp-start' });

    const template = await post('/api/notifications/templates', {
      eventKey: 'fees.receipt',
      channel: 'whatsapp',
      body: 'Received ₹{{amount}} for {{student.name}}. Receipt {{receiptNo}}.',
      providerTemplateId: 'fee_receipt:en_US',
    });
    expect(template.status).toBe(201);
    const pdf = await asT(() =>
      FileObject.create({
        instituteId: T.id,
        module: 'fees',
        storageDriver: 'local',
        storageKey: `test/receipts/${RUN}.pdf`,
        originalName: 'receipt.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      }),
    );

    const sent = await deliver('whatsapp', { attachment: { fileId: pdf.id, filename: 'receipt-R-1.pdf' } });
    expect(sent).toMatchObject({ queued: 1, skipped: 0 });
    const call = lastCall('graph.facebook.com');
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe(`/v27.0/${META.phoneNumberId}/messages`);
    expect(call.headers.authorization).toBe(`Bearer ${META.accessToken}`);
    const payload = JSON.parse(call.body);
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: WA_ID,
      type: 'template',
      template: { name: 'fee_receipt', language: { code: 'en_US' } },
    });
    expect(payload.template.components).toMatchObject([
      {
        type: 'header',
        parameters: [
          {
            type: 'document',
            document: { filename: 'receipt-R-1.pdf', link: expect.stringContaining('/api/files/signed/') },
          },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: '500' },
          { type: 'text', text: 'Asha' },
          { type: 'text', text: `R-${RUN}` },
        ],
      },
    ]);
    whatsappId = sent.messageIds[0];
    expect(await message(whatsappId)).toMatchObject({
      status: 'sent',
      provider: 'whatsapp-cloud',
      providerTemplateId: 'fee_receipt:en_US',
      providerMessageId: expect.stringMatching(/^wamid\./),
    });
  });

  it('applies signed WhatsApp status webhooks once, and honours STOP', async () => {
    const wamid = (await message(whatsappId))!.providerMessageId!;
    const forged = await metaPost(metaHook, metaStatus(wamid, 'delivered'), hex(16));
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await message(whatsappId))!.status).toBe('sent');

    const delivered = await metaPost(metaHook, metaStatus(wamid, 'delivered'), META.appSecret);
    expect(delivered.status).toBe(200);
    expect(delivered.body).toMatchObject({ received: true, receipts: 1, updated: 1 });
    expect(await message(whatsappId)).toMatchObject({ status: 'delivered' });
    // Redelivered and later statuses ("read") leave the delivered message alone.
    expect((await metaPost(metaHook, metaStatus(wamid, 'delivered'), META.appSecret)).body).toMatchObject({
      updated: 0,
    });
    expect((await metaPost(metaHook, metaStatus(wamid, 'read'), META.appSecret)).body).toMatchObject({
      updated: 0,
    });

    const malformed = await metaPost(metaHook, '{bad', META.appSecret, 'text/plain');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_WEBHOOK');

    expect((await metaPost(metaHook, metaReply('STOP'), META.appSecret)).body).toMatchObject({ consent: 1 });
    expect(await consentOf('whatsapp')).toMatchObject({ enabled: false, source: 'whatsapp-stop' });
    const stopped = await deliver('whatsapp');
    expect(await message(stopped.messageIds[0])).toMatchObject({
      status: 'skipped',
      lastError: 'Recipient opted out',
    });
  });

  it('sends DLT-registered SMS through MSG91 and applies its delivery reports', async () => {
    const saved = await put(`${PROVIDERS}/sms`, { provider: 'msg91', isActive: true, settings: MSG91 });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(MSG91.authKey);
    const msg91Hook: string = saved.body.webhook.url;
    expect(msg91Hook).toMatch(/\/api\/notifications\/public\/webhooks\/msg91\/[^/?]{10,80}$/);
    // Switching vendor retires the Twilio callback URL.
    expect((await twilioPost(twilioHook, twilioInbound('STOP'), TWILIO.authToken)).status).toBe(404);

    const template = await post('/api/notifications/templates', {
      eventKey: 'fees.receipt',
      channel: 'sms',
      body: 'Fee of Rs {{amount}} received for {{student.name}}. Receipt {{receiptNo}}. - APEX',
      providerTemplateId: '1207161234567890123',
    });
    expect(template.status).toBe(201);
    const sent = await deliver('sms');
    expect(sent).toMatchObject({ queued: 1, skipped: 0 });
    const call = lastCall('api.msg91.com');
    expect(call.method).toBe('GET');
    expect(call.url.pathname).toBe('/api/sendhttp.php');
    expect(Object.fromEntries(call.url.searchParams)).toMatchObject({
      authkey: MSG91.authKey,
      mobiles: WA_ID,
      sender: MSG91.senderId,
      route: '4',
      DLT_TE_ID: '1207161234567890123',
      PE_ID: MSG91.dltEntityId,
      message: `Fee of Rs 500 received for Asha. Receipt R-${RUN}. - APEX`,
    });
    const id = sent.messageIds[0];
    expect(await message(id)).toMatchObject({ status: 'sent', provider: 'msg91' });
    const requestId = (await message(id))!.providerMessageId!;

    const report = [
      {
        senderId: MSG91.senderId,
        requestId,
        userId: '338562',
        report: [{ date: '2026-01-01 10:00:05', number: WA_ID, status: '1', desc: 'DELIVERED' }],
      },
    ];
    const dlr = await request(await getApp())
      .post(new URL(msg91Hook).pathname)
      .type('form')
      .send(`data=${encodeURIComponent(JSON.stringify(report))}`);
    expect(dlr.status).toBe(200);
    expect(dlr.body).toMatchObject({ received: true, receipts: 1, updated: 1 });
    expect(await message(id)).toMatchObject({ status: 'delivered' });
  });

  it('delivers push through FCM to Android and APNs to iOS, and prunes dead tokens', async () => {
    const saved = await put(`${PROVIDERS}/push`, { provider: 'fcm', isActive: true, settings: FCM });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain('PRIVATE KEY');
    expect(saved.body.webhook).toBeUndefined();

    const android = `fcm-${hex(40)}`;
    const ios = hex(32);
    const web = `web-${hex(20)}`;
    const register = (token: string, platform: 'android' | 'ios' | 'web') =>
      post('/api/notifications/push-tokens', { token, platform, deviceUid: `test-${platform}-${RUN}` });
    expect((await register(android, 'android')).status).toBe(201);
    expect((await register(ios, 'ios')).status).toBe(201);
    expect((await register(web, 'web')).status).toBe(201);
    expect((await register(ios, 'ios')).status).toBe(200);

    // A vendor push provider skips browser tokens: one message per Android and iOS device.
    const sent = await deliver('push');
    expect(sent).toMatchObject({ queued: 2, skipped: 0 });
    const fcm = lastCall('fcm.googleapis.com');
    expect(fcm.method).toBe('POST');
    expect(fcm.url.pathname).toBe(`/v1/projects/${FCM.projectId}/messages:send`);
    expect(fcm.headers.authorization).toMatch(/^Bearer ya29\./);
    expect(JSON.parse(fcm.body).message.token).toBe(android);
    expect(lastCall('oauth2.googleapis.com').method).toBe('POST');
    const apns = h2Calls[h2Calls.length - 1];
    expect(apns).toMatchObject({ origin: 'https://api.sandbox.push.apple.com', path: `/3/device/${ios}` });
    expect(apns.headers['apns-topic']).toBe(FCM.apnsBundleId);
    expect(apns.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    for (const id of sent.messageIds) {
      expect(await message(id)).toMatchObject({ status: 'sent', provider: 'fcm' });
    }

    // Uninstalled apps: FCM answers UNREGISTERED and APNs 410; both tokens are removed.
    httpOverride = (call) =>
      call.url.hostname === 'fcm.googleapis.com'
        ? {
            status: 404,
            body: {
              error: {
                code: 404,
                message: 'Requested entity was not found.',
                status: 'NOT_FOUND',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                    errorCode: 'UNREGISTERED',
                  },
                ],
              },
            },
          }
        : undefined;
    apnsOverride = () => ({
      status: 410,
      headers: { 'apns-id': crypto.randomUUID() },
      body: JSON.stringify({ reason: 'Unregistered', timestamp: Date.now() }),
    });
    const dead = await deliver('push');
    expect(dead.queued).toBe(2);
    for (const id of dead.messageIds) {
      expect(await message(id)).toMatchObject({ status: 'failed', attempts: 1 });
    }
    const left = await PushToken.findAll({ where: { instituteId: T.id, userId: adminId } });
    expect(left.map((t) => t.platform)).toEqual(['web']);
  });

  it('sends login OTPs through the platform SMS provider', async () => {
    // Without an SMS provider of its own, the institute uses the platform default as well.
    expect((await del(`${PROVIDERS}/sms`)).status).toBe(200);

    const settings = { provider: 'twilio', enabled: true, settings: PLATFORM_TWILIO };
    const untested = await put(PLATFORM_SMS, settings, sa);
    expect(untested.status).toBe(409);
    expect(untested.body.error.code).toBe('INTEGRATION_TEST_REQUIRED');
    const saved = await put(PLATFORM_SMS, { ...settings, testTo: ADMIN_MOBILE }, sa);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      provider: 'twilio',
      enabled: true,
      configured: true,
      lastTestOk: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain(PLATFORM_TWILIO.authToken);
    platformHook = saved.body.webhook.url;
    expect(platformHook).toMatch(/\/api\/notifications\/public\/webhooks\/twilio\/[^/?]{10,80}$/);
    expect(platformHook).not.toBe(twilioHook);
    const test = form(lastCall('api.twilio.com'));
    expect(test).toMatchObject({ To: `+${WA_ID}`, From: PLATFORM_TWILIO.from });
    expect(test.Body).toMatch(/^123456 is your verification code\./);
    expect(test.StatusCallback).toBeUndefined();

    const app = await getApp();
    const device = newDevice('android');
    const requested = await request(app).post('/api/auth/otp/request').send({ mobile: ADMIN_MOBILE, device });
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe('otp_required');
    const call = lastCall('api.twilio.com');
    expect(call.headers.authorization).toBe(basicAuth(PLATFORM_TWILIO));
    const sms = form(call);
    expect(sms).toMatchObject({ To: `+${WA_ID}`, From: PLATFORM_TWILIO.from, StatusCallback: platformHook });
    const code = /^(\d{6}) is your verification code/.exec(sms.Body)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const verified = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: requested.body.challengeId, code, device });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ status: 'authenticated', accessToken: expect.any(String) });

    // A vendor outage answers a login OTP request as usual, so it doesn't reveal that the number has an
    // account (docs/security.md); the operator gets the error. A new-device code answers 503.
    httpOverride = (call) =>
      call.url.hostname === 'api.twilio.com'
        ? { status: 500, body: { code: 20500, message: 'Internal Server Error', status: 500 } }
        : undefined;
    const sent = calls.length;
    const down = await request(app).post('/api/auth/otp/request').send({ mobile: ADMIN_MOBILE, device });
    expect(calls.slice(sent).some((c) => c.url.hostname === 'api.twilio.com')).toBe(true);
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({
      status: 'otp_required',
      reason: 'otp_login',
      challengeId: expect.any(String),
    });
    expect(JSON.stringify(down.body)).not.toMatch(/twilio/i);
  });

  it("applies the platform provider's signed callbacks to institute messages", async () => {
    const sent = await deliver('sms');
    expect(sent).toMatchObject({ queued: 1 });
    const call = lastCall('api.twilio.com');
    expect(call.headers.authorization).toBe(basicAuth(PLATFORM_TWILIO));
    expect(form(call).StatusCallback).toBe(platformHook);
    const id = sent.messageIds[0];
    const sid = (await message(id))!.providerMessageId!;

    const undelivered = twilioStatus(sid, 'undelivered', PLATFORM_TWILIO, { ErrorCode: '30003' });
    // Only the platform account's auth token signs the platform URL.
    expect((await twilioPost(platformHook, undelivered, TWILIO.authToken)).status).toBe(401);
    expect((await twilioPost(platformHook, undelivered, PLATFORM_TWILIO.authToken)).status).toBe(200);
    expect(await message(id)).toMatchObject({
      status: 'failed',
      lastError: 'Twilio undelivered (error 30003)',
    });

    const check = await post(`${PLATFORM_SMS}/verify`, {}, sa);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ ok: true });
    expect(lastCall('api.twilio.com').url.pathname).toBe(
      `/2010-04-01/Accounts/${PLATFORM_TWILIO.accountSid}.json`,
    );
  });
});
