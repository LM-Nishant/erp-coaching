import { describe, expect, it } from 'vitest';
import {
  PaytmChecksumError,
  generatePaytmChecksum,
  paytmParamsString,
  verifyPaytmChecksum,
} from './paytm-checksum';

// Reference vectors produced with Paytm's official Node library (PaytmChecksum.js from
// github.com/paytm/Paytm_Node_Checksum): `calculateChecksum` with the fixed salts below, and
// `generateSignature` (random salt) for the *Random values. The key is a fake test key.
const KEY = 'sk-test-PaytmK3y';
const BODY =
  '{"requestType":"Payment","mid":"TESTMID00000001","websiteName":"WEBSTAGING","orderId":"F12-345","txnAmount":{"value":"1.00","currency":"INR"},"userInfo":{"custId":"U42"},"callbackUrl":"https://erp.example.com/api/fees/public/checkout-return/paytm"}';
const FORM = {
  BANKNAME: 'null',
  BANKTXNID: '777001234567',
  CURRENCY: 'INR',
  GATEWAYNAME: 'HDFC',
  MID: 'TESTMID00000001',
  ORDERID: 'F12-345',
  PAYMENTMODE: 'UPI',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  STATUS: 'TXN_SUCCESS',
  TXNAMOUNT: '1.00',
  TXNDATE: '2025-01-15 10:30:00.0',
  TXNID: '20250115111212800110168000000001',
};
const VECTORS = {
  bodyFixed:
    'ZhIP9bEb7B4PyMsx9tiNCH7ycuTt0jLtGwv6xTpaXseGD+iK+j0VMqcwMYogTn5Hfhs1mLmZh8nonTA0k7QY4GPa0VQmIQGnE2VkSJvpV80=',
  formNodeFixed:
    'F9vkoHs2FU75+Phto9S1NgMxaX/uYkXMe0WX7JN15IxLP+ZYVlYtEkh8vUri+4P6A2Teo0+rDRTJEf6uEqvJykXEMP15OKnT4sBN0um5ucE=',
  formPhpFixed:
    'JqAMkgo4vedWHXa5X5XxXm5iIu2PKDUj8LFQzE3mc0XFYXLQowIPRmheYhCuYPt9EgqqG6SNN6z/rhrLYyxHBzz3cHSRUJKeOZ6sDaayjwc=',
  bodyRandom:
    'dh9llqlVwPJ6hNIJEf55OnGGa3B7rKiEHBkvyA/x+nClYVfNJrGV8fBFcMcACAuBa27NKzQKq96FBLQ09zlje/SH/3ADQyXCen6w0wSNpSg=',
  formRandom:
    'qOVld+TElMccOBDY4fuGEbmZGW7/EKthJzsQxLNb0MIsZzR+c3DKC7fH+A8ZzYbV29+fY2lHgVaf2HMAyluYMIKmXbXS83lFY8XDnv6cmOA=',
};

describe('Paytm checksum', () => {
  it('matches the official library byte for byte', () => {
    expect(generatePaytmChecksum(BODY, KEY, 'aB3+')).toBe(VECTORS.bodyFixed);
    expect(generatePaytmChecksum(paytmParamsString(FORM, false), KEY, 'Xy9/')).toBe(VECTORS.formNodeFixed);
    // Form params sign "null" as empty, as the PHP/Python/Java libraries do.
    expect(generatePaytmChecksum(FORM, KEY, 'Qw12')).toBe(VECTORS.formPhpFixed);
  });

  it('verifies signatures from the official library, with either null convention', () => {
    expect(verifyPaytmChecksum(BODY, KEY, VECTORS.bodyRandom)).toBe(true);
    expect(verifyPaytmChecksum(FORM, KEY, VECTORS.formRandom)).toBe(true);
    expect(verifyPaytmChecksum(FORM, KEY, VECTORS.formNodeFixed)).toBe(true);
    expect(
      verifyPaytmChecksum({ ...FORM, CHECKSUMHASH: VECTORS.formPhpFixed }, KEY, VECTORS.formPhpFixed),
    ).toBe(true);
    expect(verifyPaytmChecksum(BODY, KEY, generatePaytmChecksum(BODY, KEY))).toBe(true);
  });

  it('rejects tampered params, other keys and malformed checksums', () => {
    expect(verifyPaytmChecksum({ ...FORM, TXNAMOUNT: '100.00' }, KEY, VECTORS.formRandom)).toBe(false);
    expect(verifyPaytmChecksum(BODY.replace('1.00', '9.00'), KEY, VECTORS.bodyRandom)).toBe(false);
    expect(verifyPaytmChecksum(BODY, 'sk-test-OtherK3y', VECTORS.bodyRandom)).toBe(false);
    expect(verifyPaytmChecksum(BODY, KEY, 'not-a-checksum')).toBe(false);
    expect(verifyPaytmChecksum(BODY, KEY, '')).toBe(false);
    expect(verifyPaytmChecksum(BODY, KEY, undefined)).toBe(false);
  });

  it('requires a 16-character merchant key', () => {
    expect(() => generatePaytmChecksum(BODY, 'sk-test-short')).toThrow(PaytmChecksumError);
    expect(() => verifyPaytmChecksum(BODY, 'sk-test-short', VECTORS.bodyFixed)).toThrow(PaytmChecksumError);
  });
});
