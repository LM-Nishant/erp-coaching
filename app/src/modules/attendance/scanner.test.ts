import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: true, scanBarcode: vi.fn() }));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('@capacitor/barcode-scanner', () => ({
  CapacitorBarcodeScanner: { scanBarcode: h.scanBarcode },
  CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 },
  CapacitorBarcodeScannerAndroidScanningLibrary: { MLKIT: 'mlkit' },
}));

const { scanQr } = await import('./scanner');

beforeEach(() => {
  h.native = true;
  h.scanBarcode.mockReset();
});

describe('attendance QR scanner', () => {
  it('scans a QR code natively and leaves the web to the browser camera fallback', async () => {
    h.scanBarcode.mockResolvedValue({ ScanResult: 'qr-token', format: 0 });
    await expect(scanQr()).resolves.toBe('qr-token');
    expect(h.scanBarcode).toHaveBeenCalledWith(expect.objectContaining({ hint: 0 }));

    h.native = false;
    await expect(scanQr()).resolves.toBeNull();
    expect(h.scanBarcode).toHaveBeenCalledOnce();
  });

  it('turns the plugin error codes into the messages check-in shows', async () => {
    h.scanBarcode.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'OS-PLUG-BARC-0007' }));
    await expect(scanQr()).rejects.toThrow('Camera permission is required to scan');
    h.scanBarcode.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'OS-PLUG-BARC-0006' }));
    await expect(scanQr()).rejects.toThrow('Scan cancelled');
    h.scanBarcode.mockRejectedValueOnce(
      Object.assign(new Error('Camera unavailable'), { code: 'OS-PLUG-BARC-0004' }),
    );
    await expect(scanQr()).rejects.toThrow('Camera unavailable');
  });
});
