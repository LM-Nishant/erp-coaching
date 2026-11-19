import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPaymentGateway,
  GatewayConfigError,
  GatewayRequestError,
  setPaymentGatewayHttp,
  WebhookSignatureError,
  type GatewayCredentials,
  type GatewayHttpRequest,
  type RefundInput,
} from './index';
import { generatePaytmChecksum, verifyPaytmChecksum } from './paytm-checksum';
import { rawJsonMember } from './paytm.gateway';

// No vendor is ever called: every request goes to the fake transport below.
type Reply =
  { status: number; body?: unknown } | ((req: GatewayHttpRequest) => { status: number; body?: unknown });

function fakeHttp(...replies: Reply[]): GatewayHttpRequest[] {
  const calls: GatewayHttpRequest[] = [];
  setPaymentGatewayHttp(async (req) => {
    calls.push(req);
    const next = replies.shift();
    if (!next) throw new Error(`Unexpected ${req.method} ${req.url}`);
    const { status, body } = typeof next === 'function' ? next(req) : next;
    return { status, body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body) };
  });
  return calls;
}

const sent = (req: GatewayHttpRequest) => JSON.parse(req.body ?? 'null');
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => err,
  );

afterEach(() => setPaymentGatewayHttp(null));

const ORDER = {
  orderId: 'F12-345',
  amountPaise: 150000,
  currency: 'INR' as const,
  customer: { id: 'u42', name: 'Test Payer', mobile: '9520000001', email: 'payer@example.com' },
  callbackUrl: 'https://erp.example.com/api/fees/public/checkout-return/tok',
  notifyUrl: 'https://erp.example.com/api/fees/public/webhooks/cashfree/7',
  description: 'Fee payment',
};
const REFUND: RefundInput = {
  gatewayOrderId: 'F12-345_ab12cd',
  gatewayPaymentId: 'pay_B',
  amountPaise: 50000,
  refundId: 'rf7x12xab',
  note: 'Overpaid',
};

describe('Razorpay', () => {
  const creds: GatewayCredentials = {
    merchantId: 'rzp_test_fakekey',
    secretKey: 'rzp-secret-1',
    webhookSecret: '123456',
    sandbox: true,
  };
  const rzp = (c: GatewayCredentials = creds) => createPaymentGateway('razorpay', c);
  const sign = (body: string) => crypto.createHmac('sha256', '123456').update(body).digest('hex');

  it("verifies webhooks against the example in Razorpay's SDK tests", async () => {
    // razorpay-node test/utils/razorpay-utils.spec.js: validateWebhookSignature.
    const body = Buffer.from('{"a":1,"b":2,"c":{"d":3}}');
    const signature = '2fe04e22977002e6c7cb553adab8b460cb9e2a4970d5953cb27a8472752e3bbc';
    expect(await rzp().verifyWebhook({ 'x-razorpay-signature': signature }, body)).toMatchObject({
      kind: 'ignored',
    });
    await expect(rzp().verifyWebhook({ 'x-razorpay-signature': 'sdfafds' }, body)).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
    await expect(
      rzp({ ...creds, webhookSecret: 'another-secret' }).verifyWebhook(
        { 'x-razorpay-signature': signature },
        body,
      ),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('maps payment and refund webhooks', async () => {
    const captured = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_29QQoUBi66xm2f',
            order_id: 'order_9A33XWu170gUtm',
            amount: 150000,
            status: 'captured',
            method: 'upi',
            fee: 3540,
            acquirer_data: { rrn: '777001234567' },
          },
        },
      },
    });
    expect(
      await rzp().verifyWebhook(
        { 'x-razorpay-signature': sign(captured), 'x-razorpay-event-id': 'evt_1' },
        Buffer.from(captured),
      ),
    ).toMatchObject({
      kind: 'payment',
      gatewayOrderId: 'order_9A33XWu170gUtm',
      gatewayPaymentId: 'pay_29QQoUBi66xm2f',
      status: 'success',
      amountPaise: 150000,
      feePaise: 3540,
      method: 'upi',
      bankReference: '777001234567',
      eventId: 'evt_1',
    });

    const failed = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_F',
            order_id: 'order_1',
            amount: 150000,
            status: 'failed',
            error_description: 'Declined',
          },
        },
      },
    });
    expect(
      await rzp().verifyWebhook({ 'x-razorpay-signature': sign(failed) }, Buffer.from(failed)),
    ).toMatchObject({
      kind: 'payment',
      status: 'failed',
      message: 'Declined',
    });

    const refund = JSON.stringify({
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_1',
            payment_id: 'pay_B',
            amount: 50000,
            status: 'processed',
            receipt: 'rf7x12xab',
          },
        },
      },
    });
    expect(
      await rzp().verifyWebhook({ 'x-razorpay-signature': sign(refund) }, Buffer.from(refund)),
    ).toMatchObject({
      kind: 'refund',
      refund: { refundId: 'rf7x12xab', gatewayRefundId: 'rfnd_1', status: 'processed', amountPaise: 50000 },
    });
  });

  it('creates orders with Basic auth and returns only public checkout data', async () => {
    const calls = fakeHttp({
      status: 200,
      body: { id: 'order_9A33XWu170gUtm', amount: 150000, currency: 'INR', status: 'created' },
    });
    const order = await rzp().createOrder(ORDER);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.razorpay.com/v1/orders' });
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from('rzp_test_fakekey:rzp-secret-1').toString('base64')}`,
    );
    expect(sent(calls[0])).toEqual({
      amount: 150000,
      currency: 'INR',
      receipt: 'F12-345',
      notes: { reference: 'F12-345' },
    });
    expect(order).toEqual({
      gatewayOrderId: 'order_9A33XWu170gUtm',
      checkout: {
        provider: 'razorpay',
        key: 'rzp_test_fakekey',
        orderId: 'order_9A33XWu170gUtm',
        amount: 150000,
        currency: 'INR',
        description: 'Fee payment',
        prefill: { name: 'Test Payer', contact: '9520000001', email: 'payer@example.com' },
        callbackUrl: ORDER.callbackUrl,
      },
    });
    expect(JSON.stringify(order)).not.toContain('rzp-secret-1');
  });

  it('rejects a key that does not match the mode before calling Razorpay', async () => {
    const calls = fakeHttp();
    const live = rzp({ ...creds, merchantId: 'rzp_live_fakekey' });
    await expect(live.createOrder(ORDER)).rejects.toBeInstanceOf(GatewayConfigError);
    expect(await live.testConnection()).toEqual({ ok: false, message: expect.stringContaining('live key') });
    expect(calls).toHaveLength(0);
  });

  it('reads the order status from its payment attempts', async () => {
    const declined = {
      id: 'pay_A',
      status: 'failed',
      amount: 150000,
      created_at: 100,
      error_description: 'Declined',
    };
    const calls = fakeHttp(
      {
        status: 200,
        body: {
          items: [declined, { id: 'pay_B', status: 'captured', amount: 150000, created_at: 90, fee: 354 }],
        },
      },
      {
        status: 200,
        body: {
          items: [declined, { ...declined, id: 'pay_C', created_at: 200, error_description: 'Cancelled' }],
        },
      },
      {
        status: 200,
        body: { items: [declined, { id: 'pay_D', status: 'authorized', amount: 150000, created_at: 300 }] },
      },
      { status: 200, body: { items: [] } },
    );
    expect(await rzp().fetchStatus('order_1')).toMatchObject({
      status: 'success',
      gatewayPaymentId: 'pay_B',
      feePaise: 354,
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.razorpay.com/v1/orders/order_1/payments',
    });
    expect(await rzp().fetchStatus('order_1')).toMatchObject({
      status: 'failed',
      gatewayPaymentId: 'pay_C',
      message: 'Cancelled',
    });
    expect(await rzp().fetchStatus('order_1')).toMatchObject({
      status: 'pending',
      gatewayPaymentId: 'pay_D',
    });
    expect(await rzp().fetchStatus('order_1')).toMatchObject({
      status: 'pending',
      gatewayPaymentId: '',
      amountPaise: 0,
    });
  });

  it('refunds once per reference', async () => {
    const created = {
      id: 'rfnd_1',
      payment_id: 'pay_B',
      amount: 50000,
      status: 'pending',
      receipt: 'rf7x12xab',
    };
    const calls = fakeHttp(
      { status: 200, body: { items: [] } },
      { status: 200, body: created },
      { status: 200, body: { items: [{ ...created, status: 'processed' }] } },
    );
    expect(await rzp().refund(REFUND)).toMatchObject({
      refundId: 'rf7x12xab',
      gatewayRefundId: 'rfnd_1',
      status: 'pending',
      amountPaise: 50000,
    });
    expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_B/refunds?count=100');
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.com/v1/payments/pay_B/refund',
    });
    expect(sent(calls[1])).toEqual({
      amount: 50000,
      speed: 'normal',
      receipt: 'rf7x12xab',
      notes: { reference: 'rf7x12xab', note: 'Overpaid' },
    });
    // Razorpay has no idempotency key: a retry finds the refund by its receipt instead of refunding again.
    expect(await rzp().refund(REFUND)).toMatchObject({ gatewayRefundId: 'rfnd_1', status: 'processed' });
    expect(calls).toHaveLength(3);
  });

  it('reports rejected refunds as failed and outages as retryable', async () => {
    fakeHttp(
      { status: 200, body: { items: [] } },
      {
        status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The refund amount is invalid' } },
      },
      { status: 200, body: { items: [] } },
      { status: 503, body: '' },
    );
    expect(await rzp().refund(REFUND)).toMatchObject({
      status: 'failed',
      gatewayRefundId: null,
      message: 'The refund amount is invalid',
    });
    const err = await failure(rzp().refund(REFUND));
    expect(err).toBeInstanceOf(GatewayRequestError);
    expect(err).toMatchObject({ retryable: true, status: 503 });
  });

  it('looks refunds up by Razorpay ID, then by our reference', async () => {
    const lookup = { ...REFUND, gatewayRefundId: 'rfnd_1' };
    const calls = fakeHttp(
      { status: 200, body: { id: 'rfnd_1', amount: 50000, status: 'processed', receipt: 'rf7x12xab' } },
      {
        status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } },
      },
      { status: 200, body: { items: [] } },
    );
    expect(await rzp().fetchRefundStatus(lookup)).toMatchObject({
      status: 'processed',
      gatewayRefundId: 'rfnd_1',
    });
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.razorpay.com/v1/refunds/rfnd_1' });
    expect(await rzp().fetchRefundStatus(lookup)).toBeNull();
  });

  it('tests the connection with a read-only call', async () => {
    const calls = fakeHttp(
      { status: 200, body: { entity: 'collection', count: 0, items: [] } },
      { status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } },
    );
    expect(await rzp().testConnection()).toEqual({ ok: true, message: 'Connected to Razorpay (test mode)' });
    expect(await rzp().testConnection()).toEqual({
      ok: false,
      message: 'Razorpay rejected the key ID or key secret',
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.razorpay.com/v1/orders?count=1',
      'GET https://api.razorpay.com/v1/orders?count=1',
    ]);
  });
});

describe('Cashfree', () => {
  const creds: GatewayCredentials = {
    merchantId: 'TEST1234567890abcdef',
    secretKey: 'cfsk_ma_test_fake_secret_8f3a',
    sandbox: true,
  };
  const cf = (c: GatewayCredentials = creds) => createPaymentGateway('cashfree', c);
  const sign = (ts: string, body: string) =>
    crypto
      .createHmac('sha256', creds.secretKey!)
      .update(ts + body)
      .digest('base64');
  const signed = (ts: string, body: string) => ({
    'x-webhook-timestamp': ts,
    'x-webhook-signature': sign(ts, body),
  });

  // Signature accepted by Cashfree's official Node SDK (cashfree-pg 6.0.6, PGVerifyWebhookSignature)
  // for this timestamp, body and (fake) client secret.
  const TS = '1617695238078';
  const RAW =
    '{"data":{"order":{"order_id":"F12-345_ab12cd","order_amount":1500,"order_currency":"INR","order_tags":null},"payment":{"cf_payment_id":5114910796551,"payment_status":"SUCCESS","payment_amount":1500,"payment_currency":"INR","payment_message":"Transaction Success","payment_time":"2025-01-15T10:30:00+05:30","bank_reference":"777001234567","auth_id":null,"payment_method":{"upi":{"channel":null,"upi_id":"payer@okbank"}},"payment_group":"upi"},"customer_details":{"customer_name":"Test Payer","customer_id":"u42","customer_email":null,"customer_phone":"9520000001"},"payment_gateway_details":{"gateway_name":"CASHFREE"}},"event_time":"2025-01-15T10:30:05+05:30","type":"PAYMENT_SUCCESS_WEBHOOK"}';
  const SIG = 'aV1kFye/arXKWZTd4BzBNCtwPXeEmNupAv2MrvCYWkQ=';

  it("verifies webhooks like Cashfree's SDK and maps payments", async () => {
    const ev = await cf().verifyWebhook(
      { 'x-webhook-timestamp': TS, 'x-webhook-signature': SIG, 'x-idempotency-key': 'whk_1' },
      Buffer.from(RAW),
    );
    expect(ev).toMatchObject({
      kind: 'payment',
      gatewayOrderId: 'F12-345_ab12cd',
      gatewayPaymentId: '5114910796551',
      status: 'success',
      amountPaise: 150000,
      method: 'upi',
      bankReference: '777001234567',
      eventId: 'whk_1',
    });
    const forged: [Record<string, string>, string][] = [
      [{ 'x-webhook-timestamp': '1617695238079', 'x-webhook-signature': SIG }, RAW],
      [{ 'x-webhook-signature': SIG }, RAW],
      [{ 'x-webhook-timestamp': TS, 'x-webhook-signature': SIG }, RAW.replace('1500', '15')],
    ];
    for (const [headers, body] of forged)
      await expect(cf().verifyWebhook(headers, Buffer.from(body))).rejects.toBeInstanceOf(
        WebhookSignatureError,
      );
  });

  it('maps failed payments, refunds and other events', async () => {
    const dropped = JSON.stringify({
      type: 'PAYMENT_USER_DROPPED_WEBHOOK',
      data: {
        order: { order_id: 'F12-345_ab12cd' },
        payment: {
          cf_payment_id: 51149,
          payment_status: 'USER_DROPPED',
          payment_amount: '1500.00',
          payment_message: 'User dropped',
        },
      },
    });
    expect(await cf().verifyWebhook(signed(TS, dropped), Buffer.from(dropped))).toMatchObject({
      kind: 'payment',
      status: 'failed',
      amountPaise: 150000,
      message: 'User dropped',
    });
    const refund = JSON.stringify({
      type: 'REFUND_STATUS_WEBHOOK',
      data: {
        refund: {
          cf_refund_id: 11325632,
          cf_payment_id: 5114910796551,
          refund_id: 'rf7x12xab',
          order_id: 'F12-345_ab12cd',
          refund_amount: 500,
          refund_status: 'SUCCESS',
        },
      },
    });
    expect(await cf().verifyWebhook(signed(TS, refund), Buffer.from(refund))).toMatchObject({
      kind: 'refund',
      refund: {
        refundId: 'rf7x12xab',
        gatewayRefundId: '11325632',
        status: 'processed',
        amountPaise: 50000,
        gatewayOrderId: 'F12-345_ab12cd',
        gatewayPaymentId: '5114910796551',
      },
    });
    const settlement = JSON.stringify({ type: 'SETTLEMENT_WEBHOOK', data: {} });
    expect(await cf().verifyWebhook(signed(TS, settlement), Buffer.from(settlement))).toMatchObject({
      kind: 'ignored',
    });
  });

  it('creates orders with the API version, a unique order ID and https-only URLs', async () => {
    const echo = (req: GatewayHttpRequest) => ({
      status: 200,
      body: { order_id: sent(req).order_id, payment_session_id: 'session_abc', order_status: 'ACTIVE' },
    });
    const calls = fakeHttp(echo, echo);
    const order = await cf().createOrder({
      ...ORDER,
      customer: { ...ORDER.customer, mobile: '+91 95200 00001' },
      callbackUrl: 'http://localhost:4109/api/fees/public/checkout-return/tok',
    });
    const body = sent(calls[0]);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://sandbox.cashfree.com/pg/orders' });
    expect(calls[0].headers).toMatchObject({
      'x-client-id': 'TEST1234567890abcdef',
      'x-client-secret': 'cfsk_ma_test_fake_secret_8f3a',
      'x-api-version': '2026-01-01',
    });
    expect(body.order_id).toMatch(/^F12-345_[0-9a-f]{6}$/);
    expect(body).toMatchObject({
      order_amount: 1500,
      order_currency: 'INR',
      customer_details: {
        customer_id: 'u42',
        customer_phone: '9520000001',
        customer_name: 'Test Payer',
        customer_email: 'payer@example.com',
      },
      order_meta: { notify_url: ORDER.notifyUrl },
      order_tags: { reference: 'F12-345' },
    });
    expect(body.order_meta).not.toHaveProperty('return_url');
    expect(order).toEqual({
      gatewayOrderId: body.order_id,
      checkout: {
        provider: 'cashfree',
        mode: 'sandbox',
        paymentSessionId: 'session_abc',
        orderId: body.order_id,
      },
    });

    const live = await cf({ ...creds, sandbox: false }).createOrder(ORDER);
    expect(calls[1].url).toBe('https://api.cashfree.com/pg/orders');
    expect(sent(calls[1]).order_meta.return_url).toBe(ORDER.callbackUrl);
    expect(live.checkout).toMatchObject({ mode: 'production' });
  });

  it('reads the order status from its payments', async () => {
    const calls = fakeHttp(
      {
        status: 200,
        body: [
          {
            cf_payment_id: 1,
            payment_status: 'FAILED',
            payment_amount: 1500,
            payment_time: '2025-01-15T10:00:00+05:30',
          },
          {
            cf_payment_id: 2,
            payment_status: 'SUCCESS',
            payment_amount: 1500,
            bank_reference: '777',
            payment_group: 'upi',
          },
        ],
      },
      {
        status: 200,
        body: [
          { cf_payment_id: 3, payment_amount: 1500, payment_method: { upi: {}, payment_status: 'PENDING' } },
        ],
      },
      {
        status: 200,
        body: [
          {
            cf_payment_id: 4,
            payment_status: 'FAILED',
            payment_amount: 1500,
            payment_time: '2025-01-15T10:00:00+05:30',
          },
          {
            cf_payment_id: 5,
            payment_status: 'USER_DROPPED',
            payment_amount: 1500,
            payment_time: '2025-01-15T11:00:00+05:30',
          },
        ],
      },
      { status: 200, body: [] },
    );
    expect(await cf().fetchStatus('F12-345_ab12cd')).toMatchObject({
      status: 'success',
      gatewayPaymentId: '2',
      amountPaise: 150000,
      bankReference: '777',
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://sandbox.cashfree.com/pg/orders/F12-345_ab12cd/payments',
    });
    expect(await cf().fetchStatus('F12-345_ab12cd')).toMatchObject({
      status: 'pending',
      gatewayPaymentId: '3',
    });
    expect(await cf().fetchStatus('F12-345_ab12cd')).toMatchObject({
      status: 'failed',
      gatewayPaymentId: '5',
    });
    expect(await cf().fetchStatus('F12-345_ab12cd')).toMatchObject({
      status: 'pending',
      gatewayPaymentId: '',
    });
  });

  it('refunds idempotently by reference', async () => {
    const refund = {
      cf_refund_id: '11325632',
      refund_id: 'rf7x12xab',
      refund_amount: 500,
      refund_status: 'PENDING',
    };
    const calls = fakeHttp(
      { status: 200, body: refund },
      { status: 409, body: { message: 'refund_id already exists', code: 'refund_already_exists' } },
      { status: 200, body: { ...refund, refund_status: 'SUCCESS' } },
      { status: 400, body: { message: 'refund_amount : invalid value', code: 'refund_amount_invalid' } },
    );
    expect(await cf().refund(REFUND)).toMatchObject({
      status: 'pending',
      gatewayRefundId: '11325632',
      amountPaise: 50000,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://sandbox.cashfree.com/pg/orders/F12-345_ab12cd/refunds',
    });
    expect(calls[0].headers['x-idempotency-key']).toBe('rf7x12xab');
    expect(sent(calls[0])).toEqual({
      refund_amount: 500,
      refund_id: 'rf7x12xab',
      refund_note: 'Overpaid',
      refund_speed: 'STANDARD',
    });
    // A repeated reference answers 409: the existing refund is reported instead.
    expect(await cf().refund(REFUND)).toMatchObject({ status: 'processed', gatewayRefundId: '11325632' });
    expect(calls[2]).toMatchObject({
      method: 'GET',
      url: 'https://sandbox.cashfree.com/pg/orders/F12-345_ab12cd/refunds/rf7x12xab',
    });
    expect(await cf().refund(REFUND)).toMatchObject({
      status: 'failed',
      gatewayRefundId: null,
      message: 'refund_amount : invalid value',
    });
  });

  it('treats an unknown refund as missing and tests keys without creating an order', async () => {
    const calls = fakeHttp(
      { status: 404, body: { message: 'Refund does not exist', code: 'refund_not_found' } },
      { status: 404, body: { message: 'order not found', code: 'order_not_found' } },
      { status: 401, body: { message: 'authentication Failed', code: 'request_failed' } },
    );
    expect(await cf().fetchRefundStatus(REFUND)).toBeNull();
    expect(await cf().testConnection()).toEqual({ ok: true, message: 'Connected to Cashfree (sandbox)' });
    expect(calls[1].method).toBe('GET');
    expect(calls[1].url).toMatch(/^https:\/\/sandbox\.cashfree\.com\/pg\/orders\/conn_test_[0-9a-f]{12}$/);
    expect(await cf().testConnection()).toEqual({
      ok: false,
      message: 'Cashfree rejected the client ID or client secret',
    });
  });
});

describe('Paytm', () => {
  const KEY = 'sk-test-PaytmK3y';
  const MID = 'TESTMID00000001';
  const creds: GatewayCredentials = { merchantId: MID, secretKey: KEY, sandbox: true };
  const paytm = (c: GatewayCredentials = creds) => createPaymentGateway('paytm', c);
  const reply = (body: object) => ({
    status: 200,
    body: { head: { responseTimestamp: '1736917200000', version: 'v1' }, body },
  });
  /** The request's `body` exactly as sent, and whether its `head.signature` checks out with the merchant key. */
  const signed = (req: GatewayHttpRequest) => {
    const text = req.body ?? '';
    const inner = rawJsonMember(text, 'body') ?? '';
    return {
      valid: verifyPaytmChecksum(inner, KEY, JSON.parse(text).head.signature),
      body: JSON.parse(inner),
    };
  };

  it('initiates transactions with a checksum-signed body', async () => {
    const calls = fakeHttp(
      reply({
        resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' },
        txnToken: 'f0bed8995397',
      }),
    );
    const order = await paytm().createOrder(ORDER);
    const { valid, body } = signed(calls[0]);
    expect(valid).toBe(true);
    expect(body.orderId).toMatch(/^F12-345_[0-9a-f]{6}$/);
    expect(calls[0].url).toBe(
      `https://securestage.paytmpayments.com/theia/api/v1/initiateTransaction?mid=${MID}&orderId=${body.orderId}`,
    );
    expect(body).toEqual({
      requestType: 'Payment',
      mid: MID,
      websiteName: 'WEBSTAGING',
      orderId: body.orderId,
      callbackUrl: ORDER.callbackUrl,
      txnAmount: { value: '1500.00', currency: 'INR' },
      userInfo: { custId: 'u42', mobile: '9520000001', email: 'payer@example.com' },
    });
    expect(order).toEqual({
      gatewayOrderId: body.orderId,
      checkout: {
        provider: 'paytm',
        mid: MID,
        orderId: body.orderId,
        txnToken: 'f0bed8995397',
        amount: '1500.00',
        host: 'https://securestage.paytmpayments.com',
        scriptUrl: `https://securestage.paytmpayments.com/merchantpgpui/checkoutjs/merchants/${MID}.js`,
        callbackUrl: ORDER.callbackUrl,
      },
    });
    expect(JSON.stringify(order)).not.toContain(KEY);
  });

  it('uses the production host and website names, and checks the key before calling Paytm', async () => {
    const ok = reply({ resultInfo: { resultStatus: 'S', resultCode: '0000' }, txnToken: 't' });
    const calls = fakeHttp(
      ok,
      ok,
      reply({ resultInfo: { resultStatus: 'F', resultCode: '335', resultMsg: 'Mid is invalid' } }),
    );
    await paytm({ ...creds, sandbox: false }).createOrder(ORDER);
    expect(calls[0].url).toMatch(
      /^https:\/\/secure\.paytmpayments\.com\/theia\/api\/v1\/initiateTransaction\?/,
    );
    expect(signed(calls[0]).body.websiteName).toBe('DEFAULT');
    await paytm({ ...creds, extra: { website: 'WEBSTAGING2' } }).createOrder(ORDER);
    expect(signed(calls[1]).body.websiteName).toBe('WEBSTAGING2');
    expect(await paytm().testConnection()).toEqual({
      ok: false,
      message: 'Paytm does not recognise this merchant ID (MID)',
    });

    const shortKey = paytm({ ...creds, secretKey: 'short' });
    await expect(shortKey.createOrder(ORDER)).rejects.toBeInstanceOf(GatewayConfigError);
    expect(await shortKey.testConnection()).toMatchObject({ ok: false });
    expect(calls).toHaveLength(3);
  });

  it('reads the Transaction Status API without failing payments on system errors', async () => {
    const calls = fakeHttp(
      reply({
        resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'Txn Success' },
        txnId: '20250115111212800110168000000001',
        bankTxnId: '777001234567',
        orderId: 'F12-345_ab12cd',
        txnAmount: '1500.00',
        paymentMode: 'UPI',
      }),
      reply({
        resultInfo: {
          resultStatus: 'TXN_FAILURE',
          resultCode: '227',
          resultMsg: 'Your payment has been declined by your bank.',
        },
        txnId: '20250115111212800110168000000002',
        txnAmount: '1500.00',
      }),
      reply({
        resultInfo: {
          resultStatus: 'PENDING',
          resultCode: '402',
          resultMsg: 'Looks like the payment is not complete.',
        },
      }),
      reply({ resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '501', resultMsg: 'Server Down' } }),
    );
    expect(await paytm().fetchStatus('F12-345_ab12cd')).toMatchObject({
      status: 'success',
      gatewayPaymentId: '20250115111212800110168000000001',
      amountPaise: 150000,
      method: 'UPI',
      bankReference: '777001234567',
    });
    expect(calls[0].url).toBe('https://securegw-stage.paytmpayments.in/v3/order/status');
    expect(signed(calls[0])).toEqual({ valid: true, body: { mid: MID, orderId: 'F12-345_ab12cd' } });
    expect(await paytm().fetchStatus('F12-345_ab12cd')).toMatchObject({
      status: 'failed',
      message: 'Your payment has been declined by your bank.',
    });
    expect(await paytm().fetchStatus('F12-345_ab12cd')).toMatchObject({ status: 'pending' });
    const err = await failure(paytm().fetchStatus('F12-345_ab12cd'));
    expect(err).toBeInstanceOf(GatewayRequestError);
    expect(err).toMatchObject({ retryable: true });
  });

  it('raises refunds and reads their status', async () => {
    const refund = {
      orderId: 'F12-345_ab12cd',
      refId: 'rf7x12xab',
      refundId: '1234567',
      refundAmount: '500.00',
    };
    const calls = fakeHttp(
      reply({
        ...refund,
        resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Refund request was raised' },
      }),
      reply({
        resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '617', resultMsg: 'Refund Already Raised' },
      }),
      reply({
        ...refund,
        resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10', resultMsg: 'Refund Successfull' },
      }),
      reply({
        resultInfo: {
          resultStatus: 'TXN_FAILURE',
          resultCode: '626',
          resultMsg: 'Another Refund on same order is already in Progress',
        },
      }),
      reply({
        resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '631', resultMsg: 'Record not found' },
      }),
    );
    expect(await paytm().refund(REFUND)).toMatchObject({
      refundId: 'rf7x12xab',
      gatewayRefundId: '1234567',
      status: 'pending',
      amountPaise: 50000,
    });
    expect(calls[0].url).toBe('https://securegw-stage.paytmpayments.in/refund/apply');
    expect(signed(calls[0])).toEqual({
      valid: true,
      body: {
        mid: MID,
        txnType: 'REFUND',
        orderId: 'F12-345_ab12cd',
        txnId: 'pay_B',
        refId: 'rf7x12xab',
        refundAmount: '500.00',
        comments: 'Overpaid',
      },
    });
    // Repeating a reference reports the existing refund through the Refund Status API.
    expect(await paytm().refund(REFUND)).toMatchObject({ status: 'processed', gatewayRefundId: '1234567' });
    expect(calls[2].url).toBe('https://securegw-stage.paytmpayments.in/v2/refund/status');
    expect(signed(calls[2]).body).toEqual({ mid: MID, orderId: 'F12-345_ab12cd', refId: 'rf7x12xab' });
    expect(await failure(paytm().refund(REFUND))).toMatchObject({ retryable: true });
    expect(await paytm().fetchRefundStatus(REFUND)).toBeNull();
  });

  it('verifies Payment Status webhooks by their CHECKSUMHASH', async () => {
    const params = {
      BANKTXNID: '777001234567',
      CURRENCY: 'INR',
      MID,
      ORDERID: 'F12-345_ab12cd',
      PAYMENTMODE: 'UPI',
      RESPCODE: '01',
      RESPMSG: 'Txn Success',
      STATUS: 'TXN_SUCCESS',
      TXNAMOUNT: '1500.00',
      TXNID: '20250115111212800110168000000001',
    };
    let checksum = generatePaytmChecksum(params, KEY);
    while (!checksum.includes('+')) checksum = generatePaytmChecksum(params, KEY);
    const form = new URLSearchParams({ ...params, CHECKSUMHASH: checksum }).toString();
    const ev = await paytm().verifyWebhook({}, Buffer.from(form));
    expect(ev).toMatchObject({
      kind: 'payment',
      gatewayOrderId: 'F12-345_ab12cd',
      gatewayPaymentId: '20250115111212800110168000000001',
      status: 'success',
      amountPaise: 150000,
      method: 'UPI',
      bankReference: '777001234567',
    });
    expect(ev.raw).not.toHaveProperty('CHECKSUMHASH');
    // Some senders leave "+" in the checksum unencoded.
    const loose = `${new URLSearchParams(params).toString()}&CHECKSUMHASH=${checksum}`;
    expect(await paytm().verifyWebhook({}, Buffer.from(loose))).toMatchObject({
      kind: 'payment',
      status: 'success',
    });

    const tampered = form.replace('TXNAMOUNT=1500.00', 'TXNAMOUNT=1.00');
    await expect(paytm().verifyWebhook({}, Buffer.from(tampered))).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
    const other = { ...params, MID: 'OTHERMID0000001' };
    const otherForm = new URLSearchParams({
      ...other,
      CHECKSUMHASH: generatePaytmChecksum(other, KEY),
    }).toString();
    await expect(paytm().verifyWebhook({}, Buffer.from(otherForm))).rejects.toThrow(
      'different Paytm merchant',
    );
  });

  it('confirms refund webhooks with the Refund Status API', async () => {
    const bodyText = JSON.stringify({
      mid: MID,
      orderId: 'F12-345_ab12cd',
      txnId: 'T1',
      refId: 'rf7x12xab',
      refundId: '1234567',
      refundAmount: '500.00',
      status: 'TXN_SUCCESS',
    });
    const text = `{"head":{"signature":"${generatePaytmChecksum(bodyText, KEY)}"},"body":${bodyText}}`;
    const calls = fakeHttp(
      reply({
        orderId: 'F12-345_ab12cd',
        refId: 'rf7x12xab',
        refundId: '1234567',
        refundAmount: '500.00',
        resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10', resultMsg: 'Refund Successfull' },
      }),
    );
    expect(await paytm().verifyWebhook({}, Buffer.from(text))).toMatchObject({
      kind: 'refund',
      refund: {
        refundId: 'rf7x12xab',
        gatewayRefundId: '1234567',
        status: 'processed',
        amountPaise: 50000,
        gatewayOrderId: 'F12-345_ab12cd',
        gatewayPaymentId: 'T1',
      },
    });
    expect(signed(calls[0]).body).toEqual({ mid: MID, orderId: 'F12-345_ab12cd', refId: 'rf7x12xab' });
    await expect(
      paytm().verifyWebhook({}, Buffer.from(text.replace('500.00', '900.00'))),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(calls).toHaveLength(1);
  });
});

describe('vendor HTTP transport', () => {
  const rzp = () =>
    createPaymentGateway('razorpay', { merchantId: 'rzp_test_fakekey', secretKey: 's', sandbox: true });

  it('refuses live calls in tests', async () => {
    await expect(rzp().fetchStatus('order_1')).rejects.toThrow('Live Razorpay calls are disabled in tests');
  });

  it('turns timeouts, network errors, 429 and 5xx into retryable errors', async () => {
    setPaymentGatewayHttp(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    expect(await failure(rzp().fetchStatus('order_1'))).toMatchObject({
      retryable: true,
      message: 'Razorpay did not respond in time',
    });
    setPaymentGatewayHttp(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await failure(rzp().fetchStatus('order_1'))).toMatchObject({
      retryable: true,
      message: 'Could not reach Razorpay',
    });
    fakeHttp({ status: 429, body: '' }, { status: 502, body: '<html>Bad gateway</html>' });
    expect(await failure(rzp().fetchStatus('order_1'))).toMatchObject({ retryable: true, status: 429 });
    expect(await failure(rzp().fetchStatus('order_1'))).toMatchObject({ retryable: true, status: 502 });
  });
});
