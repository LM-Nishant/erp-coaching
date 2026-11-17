import { Capacitor } from '@capacitor/core';

/**
 * Scans one QR code. Native: ML Kit barcode scanner (Capacitor plugin). Web: returns null so the
 * caller falls back to manual entry (or the browser's camera via BarcodeDetector where available).
 */
export async function scanQr(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== 'granted' && camera !== 'limited') throw new Error('Camera permission is required to scan');
  if (Capacitor.getPlatform() === 'android') {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) await BarcodeScanner.installGoogleBarcodeScannerModule();
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
  return barcodes[0]?.rawValue ?? null;
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
