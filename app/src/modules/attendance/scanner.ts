import { Capacitor } from '@capacitor/core';

/**
 * Scans one QR code. Native: the Capacitor barcode scanner (bundled ML Kit on Android, AVFoundation on iOS; supports
 * Swift Package Manager). Web: returns null so the caller falls back to the browser camera (BarcodeDetector) or manual
 * entry.
 */
export async function scanQr(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerAndroidScanningLibrary, CapacitorBarcodeScannerTypeHint } =
    await import('@capacitor/barcode-scanner');
  try {
    const { ScanResult } = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'Point the camera at the attendance QR code',
      android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.MLKIT },
    });
    return ScanResult || null;
  } catch (e) {
    throw new Error(scanErrorMessage((e as { code?: unknown }).code) ?? (e as Error).message);
  }
}

/** The plugin rejects with `OS-PLUG-BARC-0006` (cancelled) / `-0007` (no camera access) on both platforms. */
const SCAN_ERRORS: Record<number, string> = { 6: 'Scan cancelled', 7: 'Camera permission is required to scan' };
export function scanErrorMessage(code: unknown): string | undefined {
  const n = typeof code === 'string' ? /^OS-PLUG-BARC-(\d+)$/.exec(code)?.[1] : undefined;
  return n ? SCAN_ERRORS[Number(n)] : undefined;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** Browser camera scan via the BarcodeDetector API (Chrome/Edge/Android). Null when unsupported. */
export function webDetector(): BarcodeDetectorLike | null {
  const Ctor = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike })
    .BarcodeDetector;
  return Ctor ? new Ctor({ formats: ['qr_code'] }) : null;
}

/** Current position (Capacitor Geolocation: native permission prompt, browser API on web). */
export async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
    return { lat: p.coords.latitude, lng: p.coords.longitude };
  } catch {
    return null;
  }
}
