import { Capacitor, registerPlugin } from '@capacitor/core';
import type { LocationQuery } from 'vue-router';
import type { CheckoutPlatform, CheckoutReturnInput } from '@erp/shared';

/**
 * Opens a payment gateway's standard checkout (Razorpay Checkout, Paytm JS Checkout, Cashfree JS SDK) and brings the
 * payer back to the app. The checkout never decides the outcome: pages ask the API to verify the payment with the
 * gateway (`sync`), and webhooks and the reconcile job do the same on the server.
 *
 * - Web: the checkout opens over the page; when it closes the page checks the payment. A checkout that redirects
 *   comes back through the API's checkout-return link as `<path>?payment=<id>`.
 * - Android and iOS: the checkout runs in the app's WebView. While it is open, gateway and bank pages stay in the
 *   WebView instead of opening the browser and UPI links open the UPI app (PaymentCheckoutPlugin in android/ and
 *   ios/). The gateway posts its result to the checkout-return link, which sends the WebView back to the app route.
 */

interface PaymentCheckoutPlugin {
  begin(): Promise<void>;
  end(): Promise<void>;
}
const PaymentCheckout = registerPlugin<PaymentCheckoutPlugin>('PaymentCheckout');

/**
 * `completed`: the gateway reported a finished attempt (still to be verified); `dismissed`: the payer closed the
 * checkout; `away`: the app left for the gateway's page and comes back through the checkout-return link.
 */
export type CheckoutOutcome = 'completed' | 'dismissed' | 'away';

type Checkout = Record<string, unknown>;

const LOAD_FAILED = 'The payment page could not be loaded. Check your connection and try again.';
const PAYTM_SCRIPT_HOSTS = ['secure.paytmpayments.com', 'securestage.paytmpayments.com'];
const PENDING_KEY = 'erp.payment-checkout';
const PENDING_TTL_MS = 60 * 60 * 1000;

interface PendingCheckout {
  paymentId: number;
  path: string;
  at: number;
}

export function checkoutPlatform(): CheckoutPlatform {
  const p = Capacitor.getPlatform();
  return p === 'android' || p === 'ios' ? p : 'web';
}

/** Where the checkout-return link sends the payer: this platform's app at `path`. */
export const checkoutReturnTo = (path: string): CheckoutReturnInput => ({
  platform: checkoutPlatform(),
  path,
});

export async function openCheckout(o: {
  paymentId: number;
  /** App route of the paying page, as sent in `returnTo`. */
  path: string;
  checkout: Checkout;
}): Promise<CheckoutOutcome> {
  const native = Capacitor.isNativePlatform();
  writePending({ paymentId: o.paymentId, path: o.path, at: Date.now() });
  if (native) await PaymentCheckout.begin().catch(() => undefined);
  let outcome: CheckoutOutcome;
  try {
    outcome = await launch(o.checkout, native);
  } catch (e) {
    writePending(null);
    endNative();
    throw e;
  }
  if (outcome !== 'away') {
    writePending(null);
    endNative();
  }
  return outcome;
}

/**
 * The payment a checkout came back to `path` with: `?payment=<id>` from the checkout-return link, or the checkout this
 * page opened before the app left for the gateway (the payer came back with the back button). Returned once.
 */
export function takeReturnedPayment(path: string, query: LocationQuery): number | null {
  endNative();
  const pending = readPending();
  const fresh = !!pending && Date.now() - pending.at < PENDING_TTL_MS;
  if (pending && (pending.path === path || !fresh)) writePending(null);
  const linked = typeof query.payment === 'string' ? Number(query.payment) : NaN;
  if (Number.isInteger(linked) && linked > 0) return linked;
  return pending && fresh && pending.path === path ? pending.paymentId : null;
}

/** `query` without the checkout-return parameter. */
export function withoutReturnQuery(query: LocationQuery): LocationQuery {
  const rest = { ...query };
  delete rest.payment;
  return rest;
}

/** Checks a payment until it is no longer pending or the waits run out: gateways can take seconds to confirm. */
export async function settlePayment<T>(
  check: () => Promise<T>,
  pending: (result: T) => boolean,
  waitsMs = [2000, 3000, 5000],
): Promise<T> {
  let result = await check();
  for (const ms of waitsMs) {
    if (!pending(result)) break;
    await new Promise((resolve) => setTimeout(resolve, ms));
    result = await check();
  }
  return result;
}

function launch(c: Checkout, native: boolean): Promise<CheckoutOutcome> {
  switch (c.provider) {
    case 'razorpay':
      return razorpay(c, native);
    case 'paytm':
      return paytm(c, native);
    case 'cashfree':
      return cashfree(c, native);
    default:
      return Promise.reject(new Error('This payment gateway cannot be opened here.'));
  }
}

type RazorpayCheckout = new (options: Record<string, unknown>) => { open(): void };

async function razorpay(c: Checkout, native: boolean): Promise<CheckoutOutcome> {
  await loadScript('https://checkout.razorpay.com/v1/checkout.js');
  const Razorpay = (window as unknown as { Razorpay?: RazorpayCheckout }).Razorpay;
  if (!Razorpay) throw new Error(LOAD_FAILED);
  return new Promise((resolve) => {
    const options: Record<string, unknown> = {
      key: c.key,
      order_id: c.orderId,
      amount: c.amount,
      currency: c.currency,
      description: c.description,
      prefill: c.prefill,
      handler: () => resolve('completed'),
      modal: { ondismiss: () => resolve('dismissed') },
    };
    // In the WebView the result is posted to the checkout-return link, and UPI apps are offered.
    if (native) Object.assign(options, { redirect: true, callback_url: c.callbackUrl, webview_intent: true });
    new Razorpay(options).open();
  });
}

interface PaytmCheckoutJs {
  onLoad(callback: () => void): void;
  init(config: Record<string, unknown>): Promise<unknown>;
  invoke(): void;
  close(): void;
}

async function paytm(c: Checkout, native: boolean): Promise<CheckoutOutcome> {
  await loadScript(paytmScriptUrl(c.scriptUrl));
  const js = (window as unknown as { Paytm?: { CheckoutJS?: PaytmCheckoutJs } }).Paytm?.CheckoutJS;
  if (!js) throw new Error(LOAD_FAILED);
  return new Promise((resolve, reject) => {
    const config = {
      root: '',
      flow: 'DEFAULT',
      data: { orderId: c.orderId, token: c.txnToken, tokenType: 'TXN_TOKEN', amount: c.amount },
      // In the WebView Paytm posts the result to the callback URL (the checkout-return link).
      merchant: { mid: c.mid, redirect: native },
      handler: {
        notifyMerchant(eventName: string) {
          if (eventName === 'APP_CLOSED' || eventName === 'SESSION_EXPIRED') resolve('dismissed');
        },
        transactionStatus() {
          js.close();
          resolve('completed');
        },
      },
    };
    js.onLoad(() => {
      js.init(config)
        .then(() => js.invoke())
        .catch(() => reject(new Error('The Paytm checkout could not be started. Try again.')));
    });
  });
}

/** The merchant script comes from the API; only Paytm's own checkout hosts may run in the app. */
function paytmScriptUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && PAYTM_SCRIPT_HOSTS.includes(url.hostname)) return url.href;
  } catch {
    // rejected below
  }
  throw new Error('This Paytm checkout cannot be opened.');
}

interface CashfreeResult {
  error?: unknown;
  redirect?: boolean;
  paymentDetails?: unknown;
}
type CashfreeFactory = (o: { mode: 'sandbox' | 'production' }) => {
  checkout(o: Record<string, unknown>): Promise<CashfreeResult | undefined>;
};

async function cashfree(c: Checkout, native: boolean): Promise<CheckoutOutcome> {
  await loadScript('https://sdk.cashfree.com/js/v3/cashfree.js');
  const Cashfree = (window as unknown as { Cashfree?: CashfreeFactory }).Cashfree;
  if (!Cashfree) throw new Error(LOAD_FAILED);
  const cf = Cashfree({ mode: c.mode === 'production' ? 'production' : 'sandbox' });
  if (native) {
    // The WebView opens Cashfree's page, which returns to the order's return_url (the checkout-return link).
    void cf
      .checkout({ paymentSessionId: c.paymentSessionId, redirectTarget: '_self' })
      .catch(() => undefined);
    return 'away';
  }
  const result = await cf.checkout({ paymentSessionId: c.paymentSessionId, redirectTarget: '_modal' });
  if (result?.redirect) return 'away';
  return result?.paymentDetails ? 'completed' : 'dismissed';
}

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const loaded = scripts.get(src);
  if (loaded) return loaded;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      scripts.delete(src);
      reject(new Error(LOAD_FAILED));
    };
    document.head.appendChild(el);
  });
  scripts.set(src, p);
  return p;
}

function endNative() {
  if (Capacitor.isNativePlatform()) void PaymentCheckout.end().catch(() => undefined);
}

function readPending(): PendingCheckout | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as Partial<PendingCheckout> | null;
    return v && Number.isInteger(v.paymentId) && typeof v.path === 'string' && typeof v.at === 'number'
      ? (v as PendingCheckout)
      : null;
  } catch {
    return null;
  }
}

function writePending(p: PendingCheckout | null) {
  try {
    if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage unavailable: the checkout-return link still carries the payment.
  }
}
