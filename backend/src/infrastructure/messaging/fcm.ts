import { MessagingError, retryAfterMs, transientStatus } from './errors';
import { ApnsSender, isApnsToken, pushData } from './apns';
import { credentialHash, parsePrivateKey, signJwt } from './jwt';
import { vendorFetch, type HttpResponse } from './transport';
import type { Channel, MessagingProvider, OutboundMessage, ProviderSettings, SendResult } from './types';
import { checkFormat, requireSetting, unsupportedChannel, vendorText } from './vendor';

/**
 * Firebase Cloud Messaging HTTP v1 (https://firebase.google.com/docs/cloud-messaging/send/v1-api)
 * with a service account. Android tokens are FCM registration tokens; iOS tokens are APNs device
 * tokens and go to APNs directly when the APNs key is configured on the same provider.
 */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const FCM_API = 'https://fcm.googleapis.com/v1';

const VENDOR = 'FCM';
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export class FcmProvider implements MessagingProvider {
  readonly name = 'fcm';
  private readonly apns: ApnsSender;

  constructor(
    readonly channel: Channel,
    private readonly settings: ProviderSettings,
  ) {
    this.apns = new ApnsSender(settings);
  }

  private account() {
    const projectId = checkFormat(
      VENDOR,
      requireSetting(VENDOR, this.settings, 'projectId', 'project id'),
      /^[a-z0-9-]{4,40}$/,
      'Firebase project id',
    );
    const clientEmail = requireSetting(VENDOR, this.settings, 'clientEmail', 'service account email');
    const raw = requireSetting(VENDOR, this.settings, 'privateKey', 'service account private key');
    return { projectId, clientEmail, raw, cacheKey: credentialHash(clientEmail, raw) };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.channel !== 'push') throw unsupportedChannel(VENDOR, this.channel);
    if (isApnsToken(message.to)) return this.apns.send(message);
    const title = message.subject || 'Notification';
    const res = await this.call({
      message: {
        token: message.to,
        notification: { title, body: message.body },
        data: pushData(message.data),
        android: { priority: 'high', notification: { sound: 'default' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      },
    });
    const name = (res.json as { name?: string } | null)?.name;
    if (res.status === 200 && name)
      return { providerMessageId: name.split('/').pop() || name, status: 'sent' };
    throw this.fcmError(res);
  }

  /** Validates a message to a dummy topic (nothing is delivered), plus the APNs key when it is set. */
  async verify(): Promise<string> {
    const res = await this.call({
      validate_only: true,
      message: { topic: 'erp-key-check', notification: { title: 'Key check', body: 'Key check' } },
    });
    if (res.status !== 200) throw this.fcmError(res);
    const fcm = `Firebase accepted the service account for project ${this.account().projectId}`;
    if (!this.apns.configured) return `${fcm}; APNs (iOS) is not configured`;
    return `${fcm}; ${await this.apns.verify()}`;
  }

  private async call(body: Record<string, unknown>): Promise<HttpResponse> {
    const account = this.account();
    return vendorFetch(VENDOR, `${FCM_API}/projects/${account.projectId}/messages:send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken(account)}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private fcmError(res: HttpResponse): MessagingError {
    const error =
      (
        res.json as {
          error?: { message?: string; status?: string; details?: { errorCode?: string }[] };
        } | null
      )?.error ?? {};
    const errorCode = error.details?.find((d) => d.errorCode)?.errorCode ?? error.status ?? '';
    const detail = vendorText(error.message) || `HTTP ${res.status}`;
    // A plain 401 is an expired access token; THIRD_PARTY_AUTH_ERROR (also 401) is a bad APNs setup in Firebase.
    const expiredToken = res.status === 401 && errorCode !== 'THIRD_PARTY_AUTH_ERROR';
    if (expiredToken) accessTokens.delete(this.account().cacheKey);
    const invalidRecipient =
      errorCode === 'UNREGISTERED' ||
      (errorCode === 'INVALID_ARGUMENT' && /registration token/i.test(detail));
    return new MessagingError(`FCM did not accept the notification: ${detail}`, {
      code: `FCM_${errorCode || res.status}`,
      invalidRecipient,
      transient:
        !invalidRecipient &&
        (transientStatus(res.status) ||
          expiredToken ||
          ['UNAVAILABLE', 'INTERNAL', 'QUOTA_EXCEEDED'].includes(errorCode)),
      status: res.status,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
    });
  }
}

/** OAuth2 access token for the service account (JWT bearer grant), cached until a minute before expiry. */
async function accessToken(account: { clientEmail: string; raw: string; cacheKey: string }): Promise<string> {
  const cached = accessTokens.get(account.cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const key = parsePrivateKey(VENDOR, account.raw, 'service account private key', 'rsa');
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { alg: 'RS256', typ: 'JWT' },
    { iss: account.clientEmail, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 },
    key,
  );
  const res = await vendorFetch('Google OAuth', GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const body = (res.json ?? {}) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (res.status === 200 && body.access_token) {
    if (accessTokens.size > 500) accessTokens.clear();
    const ttl = Math.max(60, Number(body.expires_in) || 3600) - 60;
    accessTokens.set(account.cacheKey, { token: body.access_token, expiresAt: Date.now() + ttl * 1000 });
    return body.access_token;
  }
  throw new MessagingError(
    `Google rejected the service account: ${vendorText(body.error_description || body.error) || `HTTP ${res.status}`}`,
    { code: 'FCM_AUTH', transient: transientStatus(res.status), status: res.status },
  );
}
