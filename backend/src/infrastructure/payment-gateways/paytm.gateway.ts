import crypto from 'node:crypto';
import { generatePaytmChecksum, verifyPaytmChecksum } from './paytm-checksum';
import {
  gatewayRequest,
  looksLikeEmail,
  paise,
  parseJson,
  rupees,
  tenDigitMobile,
  vendorOrderId,
  vendorText,
} from './http';
import {
  GatewayConfigError,
  GatewayRequestError,
  WebhookSignatureError,
  type ConnectionTestResult,
  type CreateOrderInput,
  type GatewayCredentials,
  type GatewayOrder,
  type GatewayPaymentStatus,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type RefundInput,
  type RefundLookup,
  type RefundResult,
  type VerifiedPayment,
} from './types';

/**
 * Paytm uses two host families: `pg` for initiateTransaction and the JS checkout, `api` for the
 * status and refund APIs (Paytm's 2025 migration to the paytmpayments domains).
 */
export const PAYTM_HOSTS = {
  staging: { pg: 'https://securestage.paytmpayments.com', api: 'https://securegw-stage.paytmpayments.in' },
  production: { pg: 'https://secure.paytmpayments.com', api: 'https://securegw.paytmpayments.in' },
} as const;

interface ResultInfo {
  resultStatus?: string;
  resultCode?: string;
  resultMsg?: string;
}

interface PaytmBody {
  resultInfo?: ResultInfo;
  txnToken?: string;
  txnId?: string;
  bankTxnId?: string;
  orderId?: string;
  txnAmount?: string;
  paymentMode?: string;
  refId?: string;
  refundId?: string;
  refundAmount?: string;
}

const KNOWN_TXN_FAILURES = new Set(['227', '235', '267', '295', '401', '810', '820', '843']);

/** Exact text of a top-level member of a JSON object: Paytm signs `body` as it was sent. */
export function rawJsonMember(text: string, key: string): string | null {
  const stringEnd = (from: number) => {
    for (let i = from + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i;
    }
    return -1;
  };
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(i);
      if (end < 0) return null;
      let j = end + 1;
      while (/\s/.test(text[j] ?? '')) j++;
      if (depth === 1 && text[j] === ':' && text.slice(i + 1, end) === key) {
        j++;
        while (/\s/.test(text[j] ?? '')) j++;
        if (text[j] !== '{') return null;
        let d = 0;
        for (let k = j; k < text.length; k++) {
          if (text[k] === '"') {
            k = stringEnd(k);
            if (k < 0) return null;
          } else if (text[k] === '{' || text[k] === '[') d++;
          else if (text[k] === '}' || text[k] === ']') {
            d--;
            if (d === 0) return text.slice(j, k + 1);
          }
        }
        return null;
      }
      i = end;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return null;
}

/** Paytm All-in-One (JS Checkout): initiateTransaction + txnToken, status and refund APIs, checksum-signed. */
export class PaytmGateway implements PaymentGateway {
  readonly name = 'paytm' as const;

  constructor(private readonly creds: GatewayCredentials) {}

  private get production() {
    return this.creds.sandbox === false;
  }

  private get hosts() {
    return this.production ? PAYTM_HOSTS.production : PAYTM_HOSTS.staging;
  }

  private get website() {
    return this.creds.extra?.website?.trim() || (this.production ? 'DEFAULT' : 'WEBSTAGING');
  }

  private keys(): { mid: string; key: string } {
    const mid = this.creds.merchantId?.trim();
    const key = this.creds.secretKey ?? '';
    if (!mid || !key) throw new GatewayConfigError('Paytm needs a merchant ID (MID) and merchant key');
    if (Buffer.byteLength(key, 'utf8') !== 16)
      throw new GatewayConfigError(
        'The Paytm merchant key must be 16 characters (copy it from the Paytm dashboard)',
      );
    return { mid, key };
  }

  private fail(info: ResultInfo | undefined, fallback: string, retryable = false): never {
    const code = String(info?.resultCode ?? '');
    if (code === '330' || code === '2005')
      throw new GatewayRequestError('paytm', 'Paytm rejected the checksum: check the merchant key', {
        code,
      });
    if (code === '335')
      throw new GatewayRequestError('paytm', 'Paytm does not recognise this merchant ID (MID)', { code });
    throw new GatewayRequestError('paytm', `Paytm: ${vendorText(info?.resultMsg, fallback)}`, {
      code: code || undefined,
      retryable,
    });
  }

  /** POSTs `{"body":…,"head":{"signature":…}}` with the checksum over the exact body string. */
  private async call(url: string, body: Record<string, unknown>): Promise<PaytmBody> {
    const { key } = this.keys();
    const bodyText = JSON.stringify(body);
    const signature = generatePaytmChecksum(bodyText, key);
    const res = await gatewayRequest('paytm', {
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: `{"body":${bodyText},"head":{"signature":${JSON.stringify(signature)}}}`,
    });
    const b = (res.json as { body?: PaytmBody } | null)?.body;
    if (res.status < 200 || res.status >= 300 || !b)
      throw new GatewayRequestError('paytm', `Paytm request failed (HTTP ${res.status})`, {
        status: res.status,
      });
    return b;
  }

  private async initiate(
    orderId: string,
    amountPaise: number,
    callbackUrl: string,
    customer: CreateOrderInput['customer'],
  ) {
    const { mid } = this.keys();
    const custId =
      (customer.id ?? '').replace(/[^A-Za-z0-9@!=_$.]/g, '').slice(0, 64) ||
      `CUST_${tenDigitMobile(customer.mobile) || 'guest'}`;
    const mobile = tenDigitMobile(customer.mobile);
    const b = await this.call(
      `${this.hosts.pg}/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(mid)}&orderId=${encodeURIComponent(orderId)}`,
      {
        requestType: 'Payment',
        mid,
        websiteName: this.website,
        orderId,
        callbackUrl,
        txnAmount: { value: rupees(amountPaise), currency: 'INR' },
        userInfo: {
          custId,
          ...(mobile.length === 10 ? { mobile } : {}),
          ...(looksLikeEmail(customer.email) ? { email: customer.email } : {}),
        },
      },
    );
    const info = b.resultInfo;
    if (info?.resultStatus === 'S' && b.txnToken) return b.txnToken;
    this.fail(info, 'could not start the transaction', info?.resultStatus === 'U');
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const { mid } = this.keys();
    const orderId = vendorOrderId(input.orderId, 50, /[A-Za-z0-9@\-_.]/);
    const txnToken = await this.initiate(orderId, input.amountPaise, input.callbackUrl, input.customer);
    return {
      gatewayOrderId: orderId,
      checkout: {
        provider: 'paytm',
        mid,
        orderId,
        txnToken,
        amount: rupees(input.amountPaise),
        host: this.hosts.pg,
        scriptUrl: `${this.hosts.pg}/merchantpgpui/checkoutjs/merchants/${encodeURIComponent(mid)}.js`,
        callbackUrl: input.callbackUrl,
      },
    };
  }

  /**
   * Transaction Status API. A TXN_FAILURE without a Paytm transaction ID (and no known decline code)
   * is treated as an error, so a misconfiguration never marks payments failed.
   */
  async fetchStatus(gatewayOrderId: string): Promise<VerifiedPayment> {
    const { mid } = this.keys();
    const b = await this.call(`${this.hosts.api}/v3/order/status`, { mid, orderId: gatewayOrderId });
    const info = b.resultInfo;
    const code = String(info?.resultCode ?? '');
    let status: GatewayPaymentStatus;
    if (info?.resultStatus === 'TXN_SUCCESS') status = 'success';
    else if (info?.resultStatus === 'PENDING' || ['331', '334', '400', '402'].includes(code))
      status = 'pending';
    else if (info?.resultStatus === 'TXN_FAILURE' && (b.txnId || KNOWN_TXN_FAILURES.has(code)))
      status = 'failed';
    else this.fail(info, 'unexpected status response', code === '501');
    return {
      gatewayOrderId,
      gatewayPaymentId: b.txnId ?? '',
      status,
      amountPaise: paise(b.txnAmount),
      method: b.paymentMode || undefined,
      bankReference: b.bankTxnId || undefined,
      message: status === 'failed' ? info?.resultMsg : undefined,
      raw: b,
    };
  }

  private refundResult(b: PaytmBody, refundId: string, status: RefundResult['status']): RefundResult {
    return {
      refundId: b.refId || refundId,
      gatewayRefundId: b.refundId || null,
      status,
      amountPaise: paise(b.refundAmount),
      message: status === 'failed' ? b.resultInfo?.resultMsg : undefined,
      raw: b,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const { mid } = this.keys();
    const b = await this.call(`${this.hosts.api}/refund/apply`, {
      mid,
      txnType: 'REFUND',
      orderId: input.gatewayOrderId,
      txnId: input.gatewayPaymentId,
      refId: input.refundId,
      refundAmount: rupees(input.amountPaise),
      ...(input.note ? { comments: input.note.slice(0, 500) } : {}),
    });
    const info = b.resultInfo;
    const code = String(info?.resultCode ?? '');
    if (info?.resultStatus === 'TXN_SUCCESS') return this.refundResult(b, input.refundId, 'processed');
    if (info?.resultStatus === 'PENDING') return this.refundResult(b, input.refundId, 'pending');
    // Already raised / already successful / pending at the bank: report the refund as it stands.
    if (code === '617' || code === '628' || code === '629')
      return (
        (await this.fetchRefundStatus(input)) ?? {
          refundId: input.refundId,
          gatewayRefundId: b.refundId || null,
          status: 'pending',
          amountPaise: input.amountPaise,
          raw: b,
        }
      );
    if (code === '626' || code === '652') this.fail(info, 'refund could not be raised now', true);
    if (code === '330' || code === '335' || info?.resultStatus !== 'TXN_FAILURE')
      this.fail(info, 'unexpected refund response');
    return { ...this.refundResult(b, input.refundId, 'failed'), amountPaise: input.amountPaise };
  }

  async fetchRefundStatus(lookup: RefundLookup): Promise<RefundResult | null> {
    const { mid } = this.keys();
    const b = await this.call(`${this.hosts.api}/v2/refund/status`, {
      mid,
      orderId: lookup.gatewayOrderId,
      refId: lookup.refundId,
    });
    const info = b.resultInfo;
    const code = String(info?.resultCode ?? '');
    if (info?.resultStatus === 'TXN_SUCCESS') return this.refundResult(b, lookup.refundId, 'processed');
    if (info?.resultStatus === 'PENDING') return this.refundResult(b, lookup.refundId, 'pending');
    if (code === '631') return null;
    if (code === '330' || code === '335' || info?.resultStatus !== 'TXN_FAILURE')
      this.fail(info, 'unexpected refund status response', code === '501');
    return this.refundResult(b, lookup.refundId, 'failed');
  }

  /** Starts (but never completes) a ₹1 transaction: proves the MID, key and website name. */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const orderId = `TEST${crypto.randomBytes(8).toString('hex')}`;
      await this.initiate(orderId, 100, `${this.hosts.pg}/theia/paytmCallback?ORDER_ID=${orderId}`, {
        id: 'CONNTEST',
        name: 'Connection test',
        mobile: '',
      });
      return { ok: true, message: `Connected to Paytm (${this.production ? 'production' : 'staging'})` };
    } catch (err) {
      if (err instanceof GatewayConfigError || err instanceof GatewayRequestError)
        return { ok: false, message: err.message };
      throw err;
    }
  }

  /**
   * Payment Status webhook: form post signed with CHECKSUMHASH over the other fields. Refund
   * webhooks: JSON `{head:{signature}, body}` signed over `body`; their status is confirmed with the
   * Refund Status API because Paytm sends "accepted" and "sent to bank" events with the same status.
   */
  async verifyWebhook(
    _headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<GatewayWebhookEvent> {
    let creds: { mid: string; key: string };
    try {
      creds = this.keys();
    } catch {
      throw new WebhookSignatureError('Paytm credentials are not configured');
    }
    const text = rawBody.toString('utf8');
    return text.trimStart().startsWith('{')
      ? this.refundWebhook(text, creds)
      : this.paymentWebhook(text, creds);
  }

  private paymentWebhook(text: string, { mid, key }: { mid: string; key: string }): GatewayWebhookEvent {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) params[k] = v;
    const checksum = params.CHECKSUMHASH ?? '';
    // Tolerate senders that do not percent-encode "+" in the base64 checksum.
    const valid =
      verifyPaytmChecksum(params, key, checksum) ||
      verifyPaytmChecksum(params, key, checksum.replace(/ /g, '+'));
    if (!valid) throw new WebhookSignatureError();
    if (params.MID !== mid) throw new WebhookSignatureError('Webhook is for a different Paytm merchant');
    const { CHECKSUMHASH: _omit, ...raw } = params;
    if (!params.ORDERID) return { kind: 'ignored', reason: 'Paytm webhook without an order ID', raw };
    const status: GatewayPaymentStatus =
      params.STATUS === 'TXN_SUCCESS' ? 'success' : params.STATUS === 'TXN_FAILURE' ? 'failed' : 'pending';
    return {
      kind: 'payment',
      gatewayOrderId: params.ORDERID,
      gatewayPaymentId: params.TXNID ?? '',
      status,
      amountPaise: paise(params.TXNAMOUNT),
      method: params.PAYMENTMODE || undefined,
      bankReference: params.BANKTXNID || undefined,
      message: status === 'failed' ? params.RESPMSG : undefined,
      raw,
    };
  }

  private async refundWebhook(
    text: string,
    { mid, key }: { mid: string; key: string },
  ): Promise<GatewayWebhookEvent> {
    const parsed = parseJson(Buffer.from(text)) as {
      head?: { signature?: string };
      body?: Record<string, unknown>;
    } | null;
    const signature = parsed?.head?.signature;
    const bodyText = rawJsonMember(text, 'body');
    const valid =
      !!signature &&
      !!parsed?.body &&
      ((bodyText != null && verifyPaytmChecksum(bodyText, key, signature)) ||
        verifyPaytmChecksum(JSON.stringify(parsed.body), key, signature));
    if (!valid || !parsed?.body) throw new WebhookSignatureError();
    const b = parsed.body;
    if (b.mid != null && String(b.mid) !== mid)
      throw new WebhookSignatureError('Webhook is for a different Paytm merchant');
    const refId = typeof b.refId === 'string' ? b.refId : '';
    const orderId = typeof b.orderId === 'string' ? b.orderId : '';
    const txnId = typeof b.txnId === 'string' ? b.txnId : '';
    if (!refId || !orderId)
      return { kind: 'ignored', reason: 'Paytm refund webhook without a refund reference', raw: b };
    const current = await this.fetchRefundStatus({
      gatewayOrderId: orderId,
      gatewayPaymentId: txnId,
      refundId: refId,
    });
    if (!current) return { kind: 'ignored', reason: 'Paytm has no refund with this reference', raw: b };
    return {
      kind: 'refund',
      refund: { ...current, gatewayOrderId: orderId, gatewayPaymentId: txnId || undefined },
      raw: b,
    };
  }
}
