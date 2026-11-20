import crypto from 'node:crypto';
import { MessagingError, transientStatus } from './errors';
import { credentialHash, parsePrivateKey, signJwt } from './jwt';
import { networkError, transport } from './transport';
import type { OutboundMessage, ProviderSettings, SendResult } from './types';
import { requireSetting, setting, vendorText } from './vendor';

/**
 * Apple Push Notification service over HTTP/2 with token (.p8 key) authentication
 * (https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
 * The iOS app registers with APNs directly (no Firebase SDK), so iOS device tokens are APNs tokens.
 */
export const APNS_PRODUCTION = 'https://api.push.apple.com';
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';

const VENDOR = 'APNs';
/** APNs device tokens are hex (32 bytes today); FCM registration tokens never are. */
export const isApnsToken = (token: string) => /^[0-9a-f]{64,200}$/i.test(token);

/** Provider tokens are valid for an hour and may be refreshed at most every 20 minutes. */
const TOKEN_TTL_MS = 50 * 60_000;
const providerTokens = new Map<string, { token: string; issuedAt: number }>();

export class ApnsSender {
  constructor(private readonly settings: ProviderSettings) {}

  /** All APNs fields are optional in the push settings; iOS delivery needs every one of them. */
  get configured(): boolean {
    return ['apnsKeyId', 'apnsTeamId', 'apnsBundleId', 'apnsPrivateKey'].every((k) =>
      setting(this.settings, k),
    );
  }

  private credentials() {
    if (!this.configured) {
      throw new MessagingError(
        'iOS push needs the APNs key id, team id, bundle id and .p8 key in the push provider settings',
        { code: 'APNS_NOT_CONFIGURED' },
      );
    }
    const keyId = requireSetting(VENDOR, this.settings, 'apnsKeyId', 'APNs key id');
    const teamId = requireSetting(VENDOR, this.settings, 'apnsTeamId', 'Apple team id');
    const raw = requireSetting(VENDOR, this.settings, 'apnsPrivateKey', 'APNs key');
    const cacheKey = credentialHash(teamId, keyId, raw);
    return {
      keyId,
      teamId,
      raw,
      cacheKey,
      topic: requireSetting(VENDOR, this.settings, 'apnsBundleId', 'bundle id'),
    };
  }

  private providerToken(c: ReturnType<ApnsSender['credentials']>): string {
    const cached = providerTokens.get(c.cacheKey);
    if (cached && Date.now() - cached.issuedAt < TOKEN_TTL_MS) return cached.token;
    const key = parsePrivateKey(VENDOR, c.raw, 'APNs key (.p8)', 'ec');
    const token = signJwt(
      { alg: 'ES256', kid: c.keyId },
      { iss: c.teamId, iat: Math.floor(Date.now() / 1000) },
      key,
    );
    if (providerTokens.size > 500) providerTokens.clear();
    providerTokens.set(c.cacheKey, { token, issuedAt: Date.now() });
    return token;
  }

  private get origins(): [string, string] {
    return setting(this.settings, 'apnsEnvironment') === 'sandbox'
      ? [APNS_SANDBOX, APNS_PRODUCTION]
      : [APNS_PRODUCTION, APNS_SANDBOX];
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const c = this.credentials();
    const payload = JSON.stringify({
      aps: { alert: { title: message.subject || 'Notification', body: message.body }, sound: 'default' },
      ...pushData(message.data),
    });
    // Development builds register sandbox tokens; try the other environment before giving up on a token.
    const [primary, secondary] = this.origins;
    let res = await this.post(c, primary, message.to, payload);
    if (res.status === 400 && res.reason === 'BadDeviceToken')
      res = await this.post(c, secondary, message.to, payload);
    if (res.status === 200) return { providerMessageId: res.apnsId || crypto.randomUUID(), status: 'sent' };
    throw apnsError(res.status, res.reason, c.cacheKey, res.retryAfter);
  }

  /** Signs a request for a dummy token: `BadDeviceToken` proves the key, key id and team id are valid. */
  async verify(): Promise<string> {
    const c = this.credentials();
    const res = await this.post(
      c,
      this.origins[0],
      '0'.repeat(64),
      JSON.stringify({ aps: { alert: 'Key check' } }),
    );
    if (res.reason === 'BadDeviceToken' || res.reason === 'DeviceTokenNotForTopic') {
      return `APNs accepted the signing key (key ${vendorText(c.keyId, 20)}, team ${vendorText(c.teamId, 20)})`;
    }
    throw apnsError(res.status, res.reason, c.cacheKey, res.retryAfter);
  }

  private async post(
    c: ReturnType<ApnsSender['credentials']>,
    origin: string,
    token: string,
    payload: string,
  ) {
    let res;
    try {
      res = await transport().http2Request(
        origin,
        `/3/device/${encodeURIComponent(token)}`,
        {
          authorization: `bearer ${this.providerToken(c)}`,
          'apns-topic': c.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        payload,
      );
    } catch (err) {
      throw networkError(VENDOR, err);
    }
    let reason: string;
    try {
      reason = res.body ? String((JSON.parse(res.body) as { reason?: string }).reason ?? '') : '';
    } catch {
      reason = '';
    }
    return {
      status: res.status,
      reason,
      apnsId: res.headers['apns-id'],
      retryAfter: res.headers['retry-after'],
    };
  }
}

const PERMANENT_REASONS: Record<string, string> = {
  InvalidProviderToken: 'APNs rejected the signing key: check the key id, team id and .p8 key',
  DeviceTokenNotForTopic: 'The device token belongs to another app: check the bundle id',
  TopicDisallowed: 'APNs does not allow pushes to this bundle id with this key',
  BadTopic: 'APNs rejected the bundle id',
  MissingTopic: 'APNs needs the bundle id',
  PayloadTooLarge: 'The notification is too large for APNs',
};

function apnsError(status: number, reason: string, cacheKey: string, retryAfter?: string): MessagingError {
  if (
    status === 410 ||
    reason === 'Unregistered' ||
    reason === 'BadDeviceToken' ||
    reason === 'ExpiredToken'
  ) {
    return new MessagingError(`APNs no longer accepts this device token (${reason || status})`, {
      code: `APNS_${reason || status}`,
      invalidRecipient: true,
      status,
    });
  }
  if (reason === 'ExpiredProviderToken') providerTokens.delete(cacheKey);
  const known = PERMANENT_REASONS[reason];
  return new MessagingError(known ?? `APNs did not accept the notification (${reason || `HTTP ${status}`})`, {
    code: `APNS_${reason || status}`,
    transient: !known && (transientStatus(status) || reason === 'ExpiredProviderToken'),
    status,
    retryAfterMs:
      retryAfter && Number(retryAfter) > 0 ? Math.min(Number(retryAfter) * 1000, 3_600_000) : undefined,
  });
}

/** Push data values are strings (FCM requires it; the app reads the same keys on both platforms). */
export function pushData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null) continue;
    if (/^(from|notification|message_type|aps)$/i.test(key) || /^(google|gcm)/i.test(key)) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}
