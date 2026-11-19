import type { SMTPTransportOptions } from 'nodemailer';
import { config } from '../config';
import { MessagingError } from './errors';
import { transport } from './transport';
import type { Channel, MessagingProvider, OutboundMessage, ProviderSettings, SendResult } from './types';
import { requireSetting, setting, unsupportedChannel, vendorText } from './vendor';

/**
 * SMTP email through nodemailer: any provider with SMTP access (Amazon SES, SendGrid, Mailgun,
 * Postmark, Google Workspace, Microsoft 365…). Port 465 uses implicit TLS; other ports upgrade
 * with STARTTLS when the server offers it, which is required unless TLS is set to `false`.
 */
const VENDOR = 'SMTP';
const NETWORK_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET', 'ECONNREFUSED']);

export class SmtpProvider implements MessagingProvider {
  readonly name = 'smtp';

  constructor(
    readonly channel: Channel,
    private readonly settings: ProviderSettings,
  ) {}

  private options(): SMTPTransportOptions {
    const host = requireSetting(VENDOR, this.settings, 'host', 'host');
    const tls = setting(this.settings, 'secure').toLowerCase();
    const port = Number(setting(this.settings, 'port') || (tls === 'true' ? 465 : 587));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MessagingError('SMTP: the port must be a number between 1 and 65535', {
        code: 'INVALID_SETTINGS',
      });
    }
    const secure = tls === 'true' || (tls === '' && port === 465);
    const user = setting(this.settings, 'user');
    return {
      host,
      port,
      secure,
      // STARTTLS is mandatory unless the admin explicitly turned TLS off (local relays on port 25).
      requireTLS: !secure && tls !== 'false',
      auth: user ? { user, pass: setting(this.settings, 'password') } : undefined,
      connectionTimeout: config.MESSAGING_TIMEOUT_MS,
      greetingTimeout: config.MESSAGING_TIMEOUT_MS,
      socketTimeout: config.MESSAGING_TIMEOUT_MS * 2,
      disableFileAccess: true,
    };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.channel !== 'email') throw unsupportedChannel(VENDOR, this.channel);
    const mailer = transport().createMailer(this.options());
    try {
      const info = await mailer.sendMail({
        from: requireSetting(VENDOR, this.settings, 'from', 'from address'),
        to: message.to,
        subject: message.subject || 'Notification',
        text: message.body,
        attachments: message.document
          ? [{ filename: message.document.filename, path: message.document.url }]
          : undefined,
      });
      if (!info.accepted.length) {
        throw new MessagingError('The SMTP server rejected the recipient address', { code: 'SMTP_REJECTED' });
      }
      return { providerMessageId: info.messageId || 'smtp', status: 'sent' };
    } catch (err) {
      throw smtpError(err);
    } finally {
      mailer.close();
    }
  }

  /** Connects and logs in without sending anything. */
  async verify(): Promise<string> {
    const options = this.options();
    const mailer = transport().createMailer(options);
    try {
      await mailer.verify();
      return `The SMTP server ${options.host}:${options.port} accepted the connection${options.auth ? ' and login' : ''}`;
    } catch (err) {
      throw smtpError(err);
    } finally {
      mailer.close();
    }
  }
}

/** nodemailer errors: `code` (EAUTH, ECONNECTION…) and the SMTP `responseCode` (4xx = try later). */
export function smtpError(err: unknown): MessagingError {
  if (err instanceof MessagingError) return err;
  const e = (err ?? {}) as { code?: string; responseCode?: number; response?: string; message?: string };
  const responseCode = Number(e.responseCode) || 0;
  if (e.code === 'EAUTH') {
    return new MessagingError('The SMTP server rejected the username or password', { code: 'SMTP_EAUTH' });
  }
  const transient = responseCode
    ? responseCode >= 400 && responseCode < 500
    : NETWORK_CODES.has(e.code ?? '') || !e.code;
  const detail = vendorText(e.response || e.message) || 'unknown error';
  return new MessagingError(`SMTP delivery failed: ${detail}`, {
    code: e.code ? `SMTP_${e.code}` : responseCode ? `SMTP_${responseCode}` : 'SMTP_ERROR',
    transient,
  });
}
