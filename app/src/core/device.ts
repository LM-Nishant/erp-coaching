import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

export interface DeviceDescriptor {
  uid: string;
  name: string;
  platform: 'web' | 'android' | 'ios';
}

let cached: DeviceDescriptor | null = null;

/** Stable per-install identifier used for device binding (max 2 active devices per user). */
export async function getDeviceDescriptor(): Promise<DeviceDescriptor> {
  if (cached) return cached;
  const [{ identifier }, info] = await Promise.all([Device.getId(), Device.getInfo()]);
  const platform = Capacitor.getPlatform() as DeviceDescriptor['platform'];
  const name =
    info.name ||
    [info.manufacturer, info.model].filter(Boolean).join(' ') ||
    `${info.operatingSystem} ${platform}`;
  cached = { uid: identifier.padEnd(8, '0'), name: name.slice(0, 100), platform };
  return cached;
}
