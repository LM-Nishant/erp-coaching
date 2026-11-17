import { config } from '../config';
import { DevWebRtcStreamingProvider } from './dev-webrtc.provider';
import type { StreamingProvider } from './types';

export * from './types';
export { DevWebRtcStreamingProvider } from './dev-webrtc.provider';

let provider: StreamingProvider | null = null;

/**
 * Active streaming adapter. `STREAMING_PROVIDER=mock` (default) is the built-in dev WebRTC adapter.
 * To add a vendor: implement `StreamingProvider` in `<vendor>.provider.ts`, add its key to the
 * `STREAMING_PROVIDER` enum in config and return it here.
 */
export function getStreamingProvider(): StreamingProvider {
  if (!provider) {
    switch (config.STREAMING_PROVIDER) {
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
