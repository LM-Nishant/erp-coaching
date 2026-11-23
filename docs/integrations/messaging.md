# Messaging: SMS, WhatsApp, email and push

The API sends SMS, WhatsApp messages, email and push notifications through provider adapters. Going live only needs
an account with a vendor and its keys, entered in the app. This page covers account setup, the keys, the webhook URLs
to paste into each vendor's dashboard, sandbox testing, and what only a real account or device can verify.

| Provider                    | Channels      | Delivery status                  | Check keys                    |
| --------------------------- | ------------- | -------------------------------- | ----------------------------- |
| Console (built in, default) | all           | n/a                              | n/a                           |
| MSG91                       | SMS, WhatsApp | Webhook                          | Balance API, sends nothing    |
| Twilio                      | SMS, WhatsApp | Status callback, signed          | Account API, sends nothing    |
| WhatsApp Cloud API (Meta)   | WhatsApp      | Webhook, signed                  | Phone number API              |
| SMTP (SES, SendGrid, …)     | Email         | None: "sent" = server accepted   | SMTP login, sends nothing     |
| Firebase Cloud Messaging    | Push          | None: "sent" = FCM/APNs accepted | `validate_only` FCM message   |
| (with APNs for iOS)         |               |                                  | APNs request to a dummy token |

## Contents

- [How a provider is chosen](#how-a-provider-is-chosen)
- [Credentials and logs](#credentials-and-logs)
- [Login OTP SMS](#login-otp-sms)
- [Templates](#templates)
- [Consent and preferences](#consent-and-preferences)
- [Delivery status, webhooks and retries](#delivery-status-webhooks-and-retries)
- [MSG91](#msg91)
- [Twilio](#twilio)
- [WhatsApp Cloud API](#whatsapp-cloud-api)
- [SMTP email](#smtp-email)
- [Push: FCM for Android, APNs for iOS](#push-fcm-for-android-apns-for-ios)
- [Settings](#settings)
- [What needs a real account or device](#what-needs-a-real-account-or-device)

## How a provider is chosen

1. **Institute provider:** an institute admin configures a provider per channel under **Communication →
   Providers**. It sends that institute's notifications.
2. **Platform default:** the super admin configures one provider per channel under **Integrations → Notification
   providers**. It sends for institutes without their own provider, and it always sends the platform's own
   messages: the login OTP SMS.
3. **Console:** without either, the built-in console provider logs the message instead of sending it. Development,
   tests and the E2E suite use it; in production it logs only the channel and a masked recipient, never the body.
   `SMS_PROVIDER`, `WHATSAPP_PROVIDER`, `EMAIL_PROVIDER` and `PUSH_PROVIDER` only select this built-in provider.
   Vendor credentials are kept per institute, encrypted in the database, so they're entered in the app.

Each provider form has **Send test**, which sends a real message to the number, address or user you enter, and
**Check keys**, which asks the vendor to accept the credentials without messaging anyone. Enabling a platform
provider whose settings changed needs a successful test first: enter a test recipient when saving, or run **Send
test** or **Check keys**.

## Credentials and logs

- Secret fields (auth keys and tokens, the app secret, the SMTP password, private keys) are encrypted with
  `ENCRYPTION_KEY` and never returned to the app. The form shows a masked hint, and leaving the field blank keeps
  the stored value. Rotate them as described in [rotating secrets](../deployment.md#rotating-secrets).
- Changing the SMTP host, port or connection security requires re-entering the password (`SECRET_REQUIRED`), so a
  stored password can't be sent to a different server.
- Logs and stored errors never contain credentials or message bodies. The API and nginx logs redact the key in
  webhook URLs, and the API log redacts the WhatsApp `hub.verify_token` (nginx logs no query strings). A failed
  message keeps the vendor's error code and reason, for example
  `Twilio did not accept the message: <Twilio's reason> (Twilio error 21211)`, in **Communication → Delivery**.
- Mobiles stored without a country code (10 digits) get `MESSAGING_DEFAULT_COUNTRY_CODE` (default `91`) before
  they go to a vendor. `MESSAGING_TIMEOUT_MS` (default 15000) bounds each vendor request.

## Login OTP SMS

Login OTPs, and the OTP for a user's additional devices, are platform messages: they always use the **platform**
SMS provider (MSG91 or Twilio). Until one is enabled, the console provider logs them, so production users can only
sign in with a password on their first device.

1. Under **Integrations → Notification providers → SMS**, choose MSG91 or Twilio and fill in the fields below.
2. **MSG91 / India (DLT):** register this template on your DLT portal, exactly as written, and enter its id as
   **Login OTP template id**:

   ```text
   {#var#} is your verification code. It expires in {#var#} minutes.
   ```

   Or create an MSG91 SMS template using `##otp##` and `##minutes##`, and enter the MSG91 template id instead. The
   minutes are `OTP_TTL_SECONDS / 60`, rounded.

3. **Send test** sends `123456 is your verification code. It expires in 5 minutes.` through that template. Enable
   the provider once it arrives.

If the vendor rejects the OTP or can't be reached, the vendor's reason is logged and reported to error tracking. A
login OTP request still answers as usual, so the response doesn't reveal that the number has an account; an OTP for
a new device, sent after a correct password, answers `503 MESSAGE_NOT_SENT` ("The message could not be sent. Try
again in a minute."). See [security.md](../security.md#passwords-otps-and-sign-in-lockout).

## Templates

Notification templates (**Communication → Templates**) have a body with `{{placeholders}}` and an optional
**Provider template id**. With a provider template id, the distinct placeholders of the body, in order of first
appearance, fill the vendor template's variables: `{{1}}`, `{{2}}`, … on WhatsApp and Twilio Content, `##var1##`,
`##var2##`, … (or the placeholder's name) on MSG91.

| Channel and provider     | Provider template id                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| SMS, MSG91 (India)       | The DLT template id (15-25 digits). The rendered body is sent with it, so it must match the registered text (`{#var#}`)   |
| SMS, MSG91 Flow          | An MSG91 template id: MSG91 renders its own text from the variables                                                       |
| SMS or WhatsApp, Twilio  | A Content template SID (`HX…`). Without one, the rendered body is sent as text                                            |
| WhatsApp, Cloud or MSG91 | An approved template name, optionally with its language: `fee_receipt` or `fee_receipt:hi` (default language: the form's) |

Without a provider template id, SMS sends the rendered body as text (Indian operators drop SMS that match no DLT
template), and WhatsApp sends free text, which Meta delivers only within 24 hours of the user's last message to
you. Business-initiated WhatsApp messages need an approved template.

**Fee receipts on WhatsApp:** **Share on WhatsApp** on a payment (or **Send to WhatsApp** under My fees) sends the
`fees.receipt-share` event with the receipt PDF attached. Vendor WhatsApp providers send the PDF as the template's
document header, so create a _utility_ template with a **Document** header and a body with five variables, in this
order: receipt number, amount, student name, payment date, download link. For example:

```text
Receipt {{1}}: ₹{{2}} received for {{3}} on {{4}}. Download: {{5}}
```

Email providers attach the same PDF. The vendor downloads it through a signed link that is valid for one hour and
renewed at every attempt.

## Consent and preferences

- Users choose channels and events under **Notifications → Preferences**. Mandatory events are always sent. Other
  messages to users who turned a channel or event off are skipped, with the reason recorded in the history.
- **WhatsApp opt-in:** WhatsApp's policy allows business messages only to users who agreed to receive them. With
  **Require WhatsApp opt-in** set to _Yes_ (the default for every WhatsApp provider), WhatsApp is off for each user
  until they turn it on in their preferences, and messages to everyone else are skipped ("No WhatsApp opt-in").
  Choose _No_ only if you collect that consent elsewhere, for example on the admission form.
- **STOP and START replies:** when a user replies STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT) by SMS
  or WhatsApp, that channel is turned off for all their events in each institute that messages them through that
  provider. START (or UNSTOP, SUBSCRIBE, OPTIN) turns it back on. The whole reply must be the keyword. Each change
  is audited as `notifications.consent_keyword`. This needs the provider's inbound webhook, below.

## Delivery status, webhooks and retries

A message is `queued`, then `sent` when the vendor accepts it, then `delivered` or `failed` when the vendor reports
back. Read receipts count as delivered. `skipped` messages were never sent (preferences, consent, no address).

**Retries:** only transient errors are retried: timeouts, network errors, HTTP 408, 429 and 5xx, and the vendors'
own throttling codes. Attempts follow exponential backoff (the provider's base delay × 2^(attempt − 1), capped at 6
hours, and never earlier than the vendor's `Retry-After`) up to the provider's maximum attempts (by default 3
attempts with a 60-second base delay). Errors that would fail again (an invalid number, an unapproved template,
wrong credentials) fail at once. Admins can re-queue a failed message with **Retry** in **Communication →
Delivery**.

**Webhooks:** once a provider that supports them is saved, its form shows the webhook URL (and, for WhatsApp Cloud,
a verify token) with copy buttons:

```text
<API_PUBLIC_URL>/api/notifications/public/webhooks/<vendor>/<webhook key>
```

| Vendor         | Where the URL goes                                                                                        | Authentication                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| MSG91          | MSG91 panel: the webhook settings for SMS delivery reports, and for WhatsApp reports and inbound messages | MSG91 doesn't sign webhooks: the random key in the URL is the secret             |
| Twilio         | Sent with every message as its status callback. For STOP/START, the number's "A message comes in" webhook | `X-Twilio-Signature` (HMAC-SHA1 with the auth token over the URL and parameters) |
| WhatsApp Cloud | Meta app → WhatsApp → Configuration: callback URL and verify token; subscribe to the `messages` field     | `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret)          |

- The URL contains a random key per provider: treat it like a password. It stays the same when you edit the
  provider, so the pasted URL keeps working; switching to another vendor gives a new URL. To change it, delete the
  institute provider and add it again (for the platform, switch to Console, save, and switch back), then update the
  vendor's dashboard.
- `API_PUBLIC_URL` must be the public HTTPS origin that the vendor reaches. Twilio signs the exact URL it calls, so
  the scheme and host must match.
- Requests with an unknown key (404) or a wrong signature (401) change nothing. Webhooks are rate-limited
  (`RATE_LIMIT_WEBHOOK_PER_MIN` per IP) and idempotent: a status only moves forward (a late "sent" after
  "delivered" is ignored), so vendor retries and duplicates change nothing.

## MSG91

For SMS in India (with DLT) and WhatsApp through MSG91. Sign up at [msg91.com](https://msg91.com) and complete KYC.

**DLT (India, SMS):** register your business as a principal entity on an operator's DLT portal (Jio, Airtel,
Vodafone Idea, BSNL, …), then your sender header and each SMS template. Link the DLT entity in MSG91.

| Field                             | Where to find it                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Auth key                          | MSG91 panel → API → Authkey. If you turn on its IP whitelisting, add the server's public IP      |
| Sender id (DLT header)            | Your approved header, for example `APEXED`                                                       |
| DLT principal entity id           | Your DLT registration                                                                            |
| Login OTP template id (platform)  | See [Login OTP SMS](#login-otp-sms)                                                              |
| WhatsApp integrated number        | The WhatsApp number connected in MSG91, with the country code: `919876543210`                    |
| Template language, require opt-in | WhatsApp: the language of your approved templates (`en`), and [opt-in](#consent-and-preferences) |

- SMS with a DLT template id goes through MSG91's DLT text API with the entity id, template id and sender. Other
  MSG91 template ids go through the Flow API.
- **Check keys** reads the account balance. MSG91 has no sandbox: test with a small balance and your own number.

## Twilio

For SMS outside India (and in India after Twilio's DLT registration), and WhatsApp through Twilio.

| Field                                | Where to find it                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Account SID, auth token              | Twilio Console → Account info (live), or Account → API keys & tokens → Test credentials |
| From number or Messaging Service SID | An SMS-capable number in E.164 format (`+15551234567`), or a Messaging Service (`MG…`)  |
| Require WhatsApp opt-in              | WhatsApp only: see [opt-in](#consent-and-preferences)                                   |

- **WhatsApp:** use a number registered as a WhatsApp sender as From; the `whatsapp:` prefix is added for you.
  Business-initiated WhatsApp messages need an approved Content template (`HX…`) as the provider template id.
- **Sandbox:** with **test credentials**, use From `+15005550006`. Twilio accepts the request but delivers nothing;
  To `+15005550001` returns "invalid number". **Check keys** reports that the test credentials were accepted. The
  **WhatsApp Sandbox** (Console → Messaging → Try it out) works with live credentials: From `+14155238886`, and each
  tester first sends the sandbox's join code to that number.
- Trial accounts send only to verified numbers.

## WhatsApp Cloud API

Meta's own API. You need a [Meta Business](https://business.facebook.com) account and an app on
[developers.facebook.com](https://developers.facebook.com) (type _Business_) with the WhatsApp product.

| Field                             | Where to find it                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone number id                   | App → WhatsApp → API Setup (an id, not the phone number)                                                                                              |
| Access token                      | Business settings → Users → System users: add a system user, assign the app and WhatsApp account, generate a token with `whatsapp_business_messaging` |
| App secret                        | App → App settings → Basic → App secret                                                                                                               |
| Business account id               | App → WhatsApp → API Setup (optional, for reference)                                                                                                  |
| Graph API version                 | Blank for the default (`v27.0`); set it when Meta retires that version                                                                                |
| Template language, require opt-in | The language of your approved templates (`en`), and [opt-in](#consent-and-preferences)                                                                |

1. Save the provider. Copy the webhook URL and verify token into App → WhatsApp → Configuration → Webhook, click
   **Verify and save**, and subscribe to the `messages` field.
2. Create templates in WhatsApp Manager → Message templates and wait for approval. Use the template name (or
   `name:language`) as the provider template id.
3. **Testing:** API Setup offers a test phone number and a temporary access token (valid 24 hours). Add up to five
   recipient numbers there, then **Send test** with the template `hello_world:en_US`. Free text arrives only after
   the recipient has messaged the number in the last 24 hours.

## SMTP email

Any SMTP service works: Amazon SES, SendGrid, Mailgun, Postmark, Brevo, Google Workspace SMTP relay, and others.

| Field               | Notes                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Host, port          | For example `email-smtp.ap-south-1.amazonaws.com` and `587`                                     |
| Connection security | STARTTLS on port 587 (default), or TLS on port 465                                              |
| Username, password  | SES: SMTP credentials (not IAM access keys). SendGrid: user `apikey` and an API key as password |
| From address        | A verified sender or domain: `Institute <noreply@example.com>`                                  |

- Set up SPF, DKIM and DMARC for the From domain, or mail lands in spam.
- **Check keys** connects and logs in without sending. For testing, use a sandbox such as Mailtrap, or the SES
  sandbox, which sends only to verified addresses.
- SMTP has no delivery reports: "sent" means the server accepted the message. Bounces go to the provider's
  dashboard or the From mailbox.

## Push: FCM for Android, APNs for iOS

Push uses one **Firebase Cloud Messaging** provider. Android devices register FCM tokens. iOS devices register
APNs tokens, which the provider sends straight to Apple's APNs with your APNs key, so the iOS app doesn't need the
Firebase SDK or `GoogleService-Info.plist`.

**Files and keys you add:**

| What                       | Where                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `google-services.json`     | `app/android/app/google-services.json` (Firebase → Project settings → your Android app)    |
| Service account key (JSON) | Its `project_id`, `client_email` and `private_key` go into the push provider, not the repo |
| APNs auth key (`.p8`)      | Its contents, key id and team id go into the push provider's APNs fields, not the repo     |

**Android:**

1. In the [Firebase console](https://console.firebase.google.com), create a project and add an Android app with the
   package name `com.erpcoaching.app` (or yours, from `app/capacitor.config.ts`).
2. Download `google-services.json` to `app/android/app/`, run `npm run cap:sync -w app` and build. The Gradle build
   applies the Google services plugin only when the file exists. Without it, the app builds and runs but skips push
   registration; CI builds it that way. The file holds identifiers, not secrets: commit it to your private fork or
   add it in your release pipeline.
3. Firebase → Project settings → Service accounts → **Generate new private key**. Copy `project_id`, `client_email`
   and `private_key` into the push provider's Firebase project id, service account email and private key fields.
   The account needs the _Firebase Cloud Messaging API Admin_ role (the default `firebase-adminsdk` account has it),
   and the _Firebase Cloud Messaging API (V1)_ must be enabled for the project in Google Cloud.

**iOS:**

1. Push needs a paid Apple Developer Program team: personal teams can't sign the push capability.
2. Apple Developer → Certificates, IDs & Profiles → Keys: create a key with **Apple Push Notifications service
   (APNs)**, download the `.p8` file (possible only once), and note its key id and your team id.
3. In the push provider, fill in the APNs key id, Apple team id, iOS bundle id (`com.erpcoaching.app` or yours), the
   `.p8` contents, and the APNs environment: _Production_ for TestFlight and App Store builds, _Sandbox_ for debug
   builds run from Xcode. A token from the other environment is retried there automatically.
4. `app/ios/App/App/App.entitlements` declares `aps-environment` as `development`; Xcode switches it to
   `production` when you archive for TestFlight or the App Store. Select your team under Signing & Capabilities.

**Tokens:** after sign-in, the app asks for permission and registers its token (for users who can see the inbox,
and not while impersonating). It removes the token on sign-out, and the API deletes the tokens of revoked devices.
Tokens that FCM reports as unregistered or invalid, or that APNs reports as unregistered (410) or bad, are deleted
after the first failed send. Web sessions have no push: they use the in-app inbox, and vendor providers skip their
tokens.

**Check keys** sends FCM a `validate_only` message, which delivers nothing. When the APNs fields are filled, it
also makes an APNs request for an all-zero token, which APNs rejects only after accepting the key.

## Settings

| Setting                          | Default | Purpose                                                                             |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `MESSAGING_TIMEOUT_MS`           | `15000` | Timeout of each vendor request (SMTP: connection and greeting, twice that for idle) |
| `MESSAGING_DEFAULT_COUNTRY_CODE` | `91`    | Country code added to 10-digit mobiles before they go to a vendor                   |
| `API_PUBLIC_URL`                 |         | Public origin in the webhook URLs                                                   |
| `RATE_LIMIT_WEBHOOK_PER_MIN`     | `300`   | Webhook requests per minute per IP                                                  |
| `OTP_TTL_SECONDS`                | `300`   | OTP validity; the OTP SMS states it in minutes                                      |

Tests and CI never call vendors: the adapters' HTTP, HTTP/2 and SMTP transports are replaced with mocks, and the
webhook signature checks are tested against the vendors' published examples.

## What needs a real account or device

These are implemented from the vendors' public API documentation and tested with mocked HTTP. Only a live account
or device can confirm them:

- **MSG91:** delivery to Indian numbers with DLT (entity, header and template ids), the Flow API, WhatsApp through
  MSG91, and the exact JSON of MSG91's delivery report and WhatsApp webhooks (MSG91 doesn't sign them or publish a
  schema).
- **Twilio:** live delivery, status callbacks and their signature on your public URL behind your proxy, WhatsApp
  senders and Content templates.
- **WhatsApp Cloud:** the webhook handshake and signature from Meta, template sends with a document header (the fee
  receipt PDF), delivery and read statuses, Graph API `v27.0`.
- **SMTP:** delivery and spam placement with your domain's SPF, DKIM and DMARC.
- **Push:** a real Android device with your `google-services.json`, an iPhone with a signed build (paid team, push
  capability), both APNs environments, and the APNs key check's dummy-token assumption.
- **OTP login** end to end in production with the platform SMS provider.
