import { config } from '../config';
import { DevWebRtcStreamingProvider } from './dev-webrtc.provider';
import { LiveKitStreamingProvider } from './livekit.provider';
import type { StreamingProvider } from './types';

export * from './types';
export { DevWebRtcStreamingProvider } from './dev-webrtc.provider';
export { LiveKitStreamingProvider, type LiveKitOptions } from './livekit.provider';

let provider: StreamingProvider | null = null;

/** LiveKit adapter from the `LIVEKIT_*` settings (validated in config). */
export function liveKitFromConfig(): LiveKitStreamingProvider {
  const c = config;
  return new LiveKitStreamingProvider({
    url: c.LIVEKIT_URL!,
    apiUrl: c.LIVEKIT_API_URL,
    apiKey: c.LIVEKIT_API_KEY!,
    apiSecret: c.LIVEKIT_API_SECRET!,
    roomPrefix: c.LIVEKIT_ROOM_PREFIX,
    recording:
      c.LIVEKIT_RECORDING_OUTPUT === 's3'
        ? {
            output: 's3',
            bucket: c.LIVEKIT_S3_BUCKET!,
            region: c.LIVEKIT_S3_REGION,
            endpoint: c.LIVEKIT_S3_ENDPOINT,
            forcePathStyle: c.LIVEKIT_S3_FORCE_PATH_STYLE,
            accessKey: c.LIVEKIT_S3_ACCESS_KEY!,
            secretKey: c.LIVEKIT_S3_SECRET_KEY!,
          }
        : { output: 'local', egressDir: c.LIVEKIT_EGRESS_OUTPUT_DIR, localDir: c.livekitRecordingsDir },
  });
}

/**
 * Active streaming adapter. `STREAMING_PROVIDER=mock` (default) is the built-in dev WebRTC adapter;
 * `livekit` is the LiveKit SFU (docs/integrations/live-streaming.md). To add a vendor: implement
 * `StreamingProvider` in `<vendor>.provider.ts`, add its key to the `STREAMING_PROVIDER` enum in
 * config and return it here.
 */
export function getStreamingProvider(): StreamingProvider {
  if (!provider) {
    switch (config.STREAMING_PROVIDER) {
      case 'livekit':
        provider = liveKitFromConfig();
        break;
      case 'mock':
      default:
        provider = new DevWebRtcStreamingProvider();
    }
  }
  return provider;
}

/** Tests / multi-provider setups can swap the adapter. */
export function setStreamingProvider(p: StreamingProvider | null): void {
  provider = p;
}
