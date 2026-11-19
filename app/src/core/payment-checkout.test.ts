import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: 'web',
  failNextLoad: false,
  begin: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => h.platform !== 'web', getPlatform: () => h.platform },
  registerPlugin: () => ({ begin: h.begin, end: h.end }),
}));

const { openCheckout, settlePayment, takeReturnedPayment, withoutReturnQuery } =
  await import('./payment-checkout');

type Opts = Record<string, unknown>;
const w = window as unknown as Opts;
const call = (f: unknown) => (f as () => void)();

// Vendor scripts are never fetched: the tests load them by firing the element's load (or error) event.
const loaded: string[] = [];
vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
  const el = node as HTMLScriptElement;
  const fail = h.failNextLoad;
  h.failNextLoad = false;
  if (!fail) loaded.push(el.src);
  setTimeout(() => (fail ? el.onerror?.(new Event('error')) : el.onload?.(new Event('load'))), 0);
  return node;
}) as typeof document.head.appendChild);

const paytmScript = (mid: string) =>
  `https://securestage.paytmpayments.com/merchantpgpui/checkoutjs/merchants/${mid}.js`;

function fakePaytm() {
  const js = {
    onLoad: (cb: () => void) => cb(),
    init: vi.fn(async (_config: Opts) => undefined),
    invoke: vi.fn(),
    close: vi.fn(),
  };
  w.Paytm = { CheckoutJS: js };
  return js;
}

beforeEach(() => {
  vi.clearAllMocks();
  loaded.length = 0;
  sessionStorage.clear();
  h.platform = 'web';
});

describe('payment checkout', () => {
  it('Razorpay in the app: stays in the WebView, offers UPI apps and posts the result to the return link', async () => {
    h.platform = 'android';
    let options: Opts = {};
    w.Razorpay = class {
      constructor(o: Opts) {
        options = o;
      }
      open() {
        expect(h.begin).toHaveBeenCalledOnce();
        call(options.handler);
      }
    };
    const callbackUrl = 'https://api.example.com/api/fees/public/checkout-return/t1';
    const outcome = await openCheckout({
      paymentId: 7,
      path: '/my-fees',
      checkout: { provider: 'razorpay', key: 'rzp_test_1', orderId: 'order_1', amount: 150000, callbackUrl },
    });
    expect(outcome).toBe('completed');
    expect(loaded).toEqual(['https://checkout.razorpay.com/v1/checkout.js']);
    expect(options).toMatchObject({
      key: 'rzp_test_1',
      order_id: 'order_1',
      amount: 150000,
      redirect: true,
      callback_url: callbackUrl,
      webview_intent: true,
    });
    expect(h.end).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
  });

  it('Razorpay on the web: opens over the page, and closing it is reported as dismissed', async () => {
    let options: Opts = {};
    w.Razorpay = class {
      constructor(o: Opts) {
        options = o;
      }
      open() {
        call((options.modal as Opts).ondismiss);
      }
    };
    const outcome = await openCheckout({
      paymentId: 8,
      path: '/subscription',
      checkout: { provider: 'razorpay' },
    });
    expect(outcome).toBe('dismissed');
    expect(options).not.toHaveProperty('redirect');
    expect(options).not.toHaveProperty('webview_intent');
    expect(h.begin).not.toHaveBeenCalled();
  });

  it("Paytm: runs only a merchant script from Paytm's checkout hosts", async () => {
    h.platform = 'ios';
    const urls = [
      'https://evil.example.com/merchantpgpui/checkoutjs/merchants/M.js',
      'http://secure.paytmpayments.com/merchantpgpui/checkoutjs/merchants/M.js',
      'https://secure.paytmpayments.com.evil.example/merchantpgpui/checkoutjs/merchants/M.js',
      'javascript:alert(1)',
    ];
    for (const scriptUrl of urls) {
      await expect(
        openCheckout({ paymentId: 3, path: '/subscription', checkout: { provider: 'paytm', scriptUrl } }),
      ).rejects.toThrow('This Paytm checkout cannot be opened.');
    }
    expect(loaded).toEqual([]);
    expect(h.end).toHaveBeenCalledTimes(urls.length);
    expect(sessionStorage.length).toBe(0);
  });

  it('Paytm in the app: posts the result to the return link and reports a finished attempt', async () => {
    h.platform = 'android';
    const js = fakePaytm();
    const outcome = openCheckout({
      paymentId: 4,
      path: '/my-fees',
      checkout: {
        provider: 'paytm',
        mid: 'MID1',
        orderId: 'O1',
        txnToken: 'tok',
        amount: '1500.00',
        scriptUrl: paytmScript('MID1'),
      },
    });
    await vi.waitFor(() => expect(js.invoke).toHaveBeenCalled());
    const config = js.init.mock.calls[0]![0];
    expect(config).toMatchObject({
      data: { orderId: 'O1', token: 'tok', tokenType: 'TXN_TOKEN', amount: '1500.00' },
      merchant: { mid: 'MID1', redirect: true },
    });
    call((config.handler as Opts).transactionStatus);
    await expect(outcome).resolves.toBe('completed');
    expect(js.close).toHaveBeenCalledOnce();
  });

  it('a checkout script that failed to load is fetched again on the next attempt', async () => {
    const js = fakePaytm();
    const checkout = { provider: 'paytm', mid: 'RETRY', scriptUrl: paytmScript('RETRY') };
    h.failNextLoad = true;
    await expect(openCheckout({ paymentId: 5, path: '/my-fees', checkout })).rejects.toThrow(
      'The payment page could not be loaded',
    );
    const outcome = openCheckout({ paymentId: 5, path: '/my-fees', checkout });
    await vi.waitFor(() => expect(js.invoke).toHaveBeenCalled());
    (js.init.mock.calls[0]![0].handler as { notifyMerchant(e: string): void }).notifyMerchant('APP_CLOSED');
    await expect(outcome).resolves.toBe('dismissed');
    expect(loaded).toEqual([paytmScript('RETRY')]);
  });

  it("Cashfree in the app: leaves for Cashfree's page, and the paying page gets the payment back once", async () => {
    h.platform = 'android';
    const checkout = vi.fn(async (_o: Opts) => undefined);
    const factory = vi.fn((_o: Opts) => ({ checkout }));
    w.Cashfree = factory;
    const outcome = await openCheckout({
      paymentId: 9,
      path: '/my-fees/buy/5',
      checkout: { provider: 'cashfree', mode: 'production', paymentSessionId: 'session_1' },
    });
    expect(outcome).toBe('away');
    expect(factory).toHaveBeenCalledWith({ mode: 'production' });
    expect(checkout).toHaveBeenCalledWith({ paymentSessionId: 'session_1', redirectTarget: '_self' });
    expect(h.end).not.toHaveBeenCalled();

    expect(takeReturnedPayment('/my-fees', {})).toBeNull();
    expect(takeReturnedPayment('/my-fees/buy/5', {})).toBe(9);
    expect(takeReturnedPayment('/my-fees/buy/5', {})).toBeNull();
    expect(h.end).toHaveBeenCalled();
  });

  it('takes the payment from the checkout-return link, which is then removed from the query', () => {
    expect(takeReturnedPayment('/subscription', { payment: '12', invoice: '3' })).toBe(12);
    expect(takeReturnedPayment('/subscription', { payment: 'x' })).toBeNull();
    expect(withoutReturnQuery({ payment: '12', invoice: '3' })).toEqual({ invoice: '3' });
  });

  it('checks a payment until it settles or the waits run out', async () => {
    const statuses = ['pending', 'pending', 'successful'];
    const check = vi.fn(async () => statuses.shift() ?? 'pending');
    await expect(settlePayment(check, (s) => s === 'pending', [0, 0, 0, 0])).resolves.toBe('successful');
    expect(check).toHaveBeenCalledTimes(3);

    const stuck = vi.fn(async () => 'pending');
    await expect(settlePayment(stuck, (s) => s === 'pending', [0, 0])).resolves.toBe('pending');
    expect(stuck).toHaveBeenCalledTimes(3);
  });
});
