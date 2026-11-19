# Biometric attendance devices

Students and staff can record attendance on ZKTeco and eSSL fingerprint, face and card terminals. Their punches go
through the same pipeline as every other attendance method:

1. Duplicates are dropped.
2. Students are marked present or late in the class (or the day) they punched for. A teacher's mark is never
   overwritten.
3. Corrections, reports and the parent portal treat these records like any others.
4. When the session closes, parents get the absence alert configured in Attendance setup.

Contents:

- [How devices connect](#how-devices-connect)
- [Server setup](#server-setup)
- [Setting up a device](#setting-up-a-device)
- [Registering a device](#registering-a-device)
- [Mapping PINs](#mapping-pins)
- [How punches are recorded](#how-punches-are-recorded)
- [Device commands](#device-commands)
- [Security and limits](#security-and-limits)
- [Troubleshooting](#troubleshooting)
- [Testing without a device](#testing-without-a-device)
- [What only a real device can verify](#what-only-a-real-device-can-verify)

## How devices connect

Each device is registered with one of two connections:

| Connection                                             | For                                                                                | The device is identified by                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ZKTeco / eSSL (ADMS push), on `/iclock/…`              | ZKTeco and eSSL terminals with ADMS firmware (the "Cloud Server" or "ADMS" menu)   | Its serial number, an optional IP allowlist, and HTTPS               |
| Punch API, `POST /api/attendance/public/device-events` | Other devices, or middleware that reads devices on the site's network and forwards | Its serial number and device key (`X-Device-Serial`, `X-Device-Key`) |

ADMS needs no middleware: the device calls the server itself, over the internet, from behind the site's router.

`BIOMETRIC_PROVIDER` selects only the punch API's payload format. Its one adapter, `mock`, accepts a JSON array of
`{ deviceSerial, enrolmentId, punchedAt, direction? }`, and development, tests and E2E use it. ADMS devices don't
depend on it.

## Server setup

nginx proxies the device paths at the server root to the API
([`iclock.conf.template`](../../deploy/nginx/templates/snippets/iclock.conf.template)). The API serves them as
`/api/attendance/public/iclock/…`:

- **HTTPS:** `https://SERVER_NAME/iclock/…`. Devices set up with an IP address, or whose TLS sends no server name,
  reach the same paths through nginx's default server. That server presents the platform certificate, which doesn't
  match an IP address, so use the host name on firmware that checks certificates.
- **Plain HTTP:** with `ADMS_ALLOW_HTTP=true` in `deploy/.env`, nginx also proxies `/iclock/` on `HTTP_PORT` instead
  of redirecting it to HTTPS. Everything else stays HTTPS-only. The API still refuses plain HTTP from devices that
  don't allow it ([registering](#registering-a-device)). Run `docker compose up -d --wait` after changing it.
- **Client address:** keep `TRUST_PROXY=1` behind the bundled nginx. Otherwise the IP allowlist sees the proxy's
  address instead of the site's.

Settings (`deploy/.env`, and `backend/.env` for local development):

| Variable                  | Default | Notes                                                                                                                                                                            |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMS_ALLOW_HTTP`         | `false` | nginx only (`deploy/.env`). `true` serves `/iclock/` over plain HTTP too, for firmware without HTTPS                                                                             |
| `RATE_LIMIT_ADMS_PER_MIN` | 600     | Requests per minute per client IP, pushes and command polls together. Devices behind one router share it. The general `RATE_LIMIT_API_PER_MIN` applies to these requests as well |
| `ADMS_MAX_BODY_KB`        | 2048    | Largest upload, at most 8192 (nginx accepts 10 MB). Checked before the body is read, and again on unpacked data packets                                                          |
| `ADMS_MAX_RECORDS`        | 10000   | Most records (lines) in one upload, checked before parsing                                                                                                                       |
| `ADMS_BACKFILL_DAYS`      | 31      | Older punches are acknowledged but not recorded: a new device's old log, or a clock set far back. Also limits **Re-send punches** and what mapping a PIN applies                 |

An idle device makes about two requests a minute: it checks for commands every 30 seconds, and uploads each punch
as it happens.

## Setting up a device

Menus differ between models and firmware versions. On most ZKTeco and eSSL terminals:

1. **Serial number:** Menu → System Info → Device Info → Serial Number. It is also on the label at the back.
2. **Register the device** in the app ([below](#registering-a-device)). Then open **Manage** on the device: it
   shows the values to enter under **Settings on the device**.
3. **Network:** Menu → COMM. → Ethernet (or Wi-Fi). The device needs an IP address, a gateway and a DNS server
   that reach the internet.
4. **Server:** Menu → COMM. → Cloud Server Setting (ADMS on some models):
   - **Server address:** the app's host name, for example `app.example.com`. Some firmware needs **Enable Domain
     Name** turned on first. Prefer the name to an IP address.
   - **Server port:** 443 (or `HTTPS_PORT`). For plain HTTP, 80 (or `HTTP_PORT`).
   - **HTTPS:** on. Turn it off only for firmware without HTTPS, after allowing plain HTTP on the server and for the
     device.
   - **Proxy server:** off.
5. **Restart the device.** Within a minute, **Last seen** in the app shows the time, and **Connected from** shows
   the site's public IP.
6. **Clock:** press **Sync clock** in the app once the device is online.

Prefer firmware with HTTPS. On firmware without it, punches and user lists cross the internet unencrypted
([security](#security-and-limits)).

## Registering a device

Attendance setup → Biometric → Devices → **Add** (permission `attendance.configure`). Branch-restricted staff see
their branches' devices and the **All branches** ones, and can change only their branches' devices.

| Field                  | Notes                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection             | **ZKTeco / eSSL (ADMS push)**, or **Other device or middleware (punch API)**. Fixed once the device is added                                                                 |
| Name                   | For example "Main gate"                                                                                                                                                      |
| Serial number          | Exactly as on the device. A serial can be registered only once on the platform. Fixed once the device is added                                                               |
| Branch                 | Punches mark classes of this branch only. **All branches** for a device shared by several branches                                                                           |
| Device clock time zone | Only if the device clock runs in another zone than the institute (an IANA name such as `Asia/Kolkata`). Punch times are read in this zone, and the device is told its offset |
| Allowed IP addresses   | Optional. The site's public IPs or ranges (`203.0.113.7`, `203.0.113.0/24`). Leave it empty if the site's address changes                                                    |
| Allow plain HTTP       | Only for firmware without HTTPS. The server needs `ADMS_ALLOW_HTTP=true` as well                                                                                             |

- **Active switch:** a disabled device is refused. Devices normally keep the refused records and upload them once
  enabled again; punches older than `ADMS_BACKFILL_DAYS` are then skipped.
- **Delete:** removes the device, its user list and its commands. Its recorded punches stay, and so do the PIN
  mappings, which belong to the institute rather than to a device.
- **Last error:** the reason for the latest refusal or skipped upload is shown with the device. Saving the device
  clears it.

## Mapping PINs

Everyone enrolled on a device has a user ID, the PIN. Attendance setup → Biometric → **Device users** lists every PIN
the devices have reported, from their user lists and from punches. Each entry shows the devices that know it and the
number of punches waiting for a mapping.

- **Map:** choose a student or, with HR enabled and the `hr.edit` permission, an employee. A PIN means the same
  person on every device of the institute, so enrol a person with the same PIN everywhere.
  - A student mapping is the attendance module's biometric enrolment.
  - An employee mapping sets the employee's **Biometric enrolment ID** in HR, which can also be edited there.
- **Apply on mapping:** mapping a PIN applies its unmatched punches from the last `ADMS_BACKFILL_DAYS` days.
- **Map a PIN:** maps a PIN that no device has reported yet, for example before the person is enrolled.
- **Unmap:** frees the PIN. Punches already recorded stay.
- **Other branches:** a PIN mapped to someone outside your branches shows as "Mapped to someone outside your
  branches", and you can't change it. Employee names show only with `hr.view`.

Device users come from the user lists that devices upload when users are added or changed. **Re-read users**
requests the full list again.

## How punches are recorded

1. **Upload.** The device uploads attendance records (`ATTLOG`): PIN, the date and time on its clock, and the punch
   state.
2. **Time.** The time is read in the device's clock time zone, or the institute's, through `shared/timezone.ts`.
   - Punches older than `ADMS_BACKFILL_DAYS` are acknowledged but skipped.
   - Punches more than 10 minutes in the future are stored as ignored, with "Punch time is in the future; check
     the device clock".
3. **Duplicates.** A punch is stored once per device, PIN and time. Re-sent records (after a lost reply, a
   **Re-send punches** or a full re-upload) never count twice. The device gets an acknowledgement for every record,
   unreadable ones included, so it stops re-sending them.
4. **Students.** For a PIN mapped to a student:
   - **Biometric devices** must be checked under the methods in Attendance setup → Rules.
   - Check-out punches (states 1, 2 and 5: check-out, break-out and overtime-out) are ignored. Other states count
     as check-in.
   - **Per class session:** the punch marks the student in each class of their batches whose check-in window covers
     the time, in the device's branch. The window runs from **Check-in opens** before the start to **Check-in
     closes** after it, or to the end of the class if that is later. After **Late after** minutes the mark is late.
   - **Once per batch per day:** the punch marks the student in each of their batches for that day.
   - An existing mark (a teacher's, a QR scan or an earlier punch) is never overwritten.
   - Closing the session marks the remaining students absent, or on leave. With **Alert parents when absent** on,
     their parents are then notified.
5. **Staff.** For a PIN mapped to an employee (HR enabled):
   - Each day's earliest punch is the check-in and the latest is the check-out, merged with the times recorded
     earlier that day.
   - The day is late when the first punch is after the shift start plus its grace minutes.
   - Days recorded manually or as leave are left alone.
   - Staff punches don't need the **Biometric devices** method.
6. **Unmapped PINs.** Their punches are stored as unmatched until the PIN is mapped.

**Recent punches** (Attendance setup → Biometric) shows each punch's outcome.

## Device commands

Manage → **Commands** (`attendance.configure`). Commands wait until the device next checks for commands, usually
within a minute while it is online.

| Button              | Sent to the device                        | Effect                                                                                                                   |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sync clock          | `RELOAD OPTIONS`                          | The device repeats its handshake and sets its clock from the server's time and its time zone offset                      |
| Refresh device info | `INFO`                                    | Updates the firmware version and the user, fingerprint and record counts                                                 |
| Re-read users       | `CHECK`                                   | The device uploads its full user list again                                                                              |
| Re-send punches     | `DATA QUERY ATTLOG StartTime=… EndTime=…` | Requests the records between two dates (device clock), within `ADMS_BACKFILL_DAYS`. Punches already recorded are skipped |

The API also accepts `{ "kind": "fetch_user", "pin": "…" }` (`DATA QUERY USERINFO PIN=…`), which re-reads one user.

- **Queue:** at most 20 commands wait per device (409 `TOO_MANY_COMMANDS`). Commands not sent within 24 hours
  expire.
- **Results:** a command is done when the device reports it. A negative return code marks it failed, shown as
  "device error" with the code.

## Security and limits

- **Identity.** ADMS firmware has no API key, so the serial number identifies the device. All of these get the same
  403 `DEVICE_FORBIDDEN`, so a caller can't tell whether a serial is registered:
  - an unknown serial, or a disabled device;
  - an address outside the device's allowlist;
  - plain HTTP when the device doesn't allow it;
  - an institute without the attendance module.

  For registered devices, the reason is shown as the device's last error.

- **Tenant.** The institute and branch come from the device's registration, never from the request.
- **No biometric data.** The server never asks devices for fingerprint or face templates or photos. Template and
  photo uploads that a device sends anyway are acknowledged and discarded. Of the device users, only PIN, name and
  privilege are stored.
- **Limits, before anything is parsed:**
  - the `adms` rate limiter, per client IP;
  - unknown and refused devices are rejected before their body is read;
  - `ADMS_MAX_BODY_KB` on the declared and the received size, and on unpacked data packets;
  - `ADMS_MAX_RECORDS` on the number of lines;
  - one request per device is processed at a time, and at most 8 can wait (429 beyond that).
- **Secrets.** ADMS devices have none, so nothing is stored for them in the encrypted settings. The `PushCommKey`
  query parameter that some firmware sends is redacted from the logs. The punch API's device keys are stored only as
  hashes and shown once.
- **Logs.** Requests from unknown serials are logged at most once every 10 minutes per serial.
- **Plain HTTP.** Allowed only on `/iclock/`, only with `ADMS_ALLOW_HTTP=true`, and only for devices set to allow it.
  The trade-off is recorded in [security.md](../security.md#biometric-devices-adms).

## Troubleshooting

The device's last error (in the device list and under Manage) usually names the problem.

| Symptom or message                                                                                  | Cause and fix                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Last seen** stays "Never" and there is no error                                                   | The device doesn't reach the server, or its serial isn't registered. Check the server address, port, HTTPS switch, and the device's gateway and DNS. Compare the serial character by character |
| Refused a request from …: not in the device's IP allowlist                                          | The site's public IP changed, or isn't the one configured. Update **Allowed IP addresses**; the message shows the address used                                                                 |
| Refused a plain-HTTP request: use HTTPS on the device, or allow plain HTTP for it                   | HTTPS is off on the device. Turn it on, or allow plain HTTP for the device                                                                                                                     |
| The device can't connect over plain HTTP, and nginx answers 301                                     | `ADMS_ALLOW_HTTP` isn't `true` on the server                                                                                                                                                   |
| Refused a request: attendance is not enabled for this institute                                     | The institute's plan or settings don't include attendance                                                                                                                                      |
| Refused an upload larger than … KB, with more than … records, or with more than … KB of records     | A large backlog arrived in one upload, and the device keeps re-sending it. Raise `ADMS_MAX_BODY_KB` or `ADMS_MAX_RECORDS` until it has gone through                                            |
| Refused a corrupt data packet                                                                       | A compressed upload couldn't be unpacked. If it persists, note the firmware version (Manage → Refresh device info) and report it                                                               |
| Skipped attendance records: … unreadable, … older than … days                                       | Lines in an unexpected format, or old records: a new device's log, or a wrong device clock. For a first import of older punches, raise `ADMS_BACKFILL_DAYS` temporarily                        |
| Server error while processing a request from the device; it will retry                              | Find the error in the API log by time and serial                                                                                                                                               |
| Punches show "Unknown enrolment id"                                                                 | The PIN isn't mapped. Map it under **Device users**; its recent punches are then applied                                                                                                       |
| Punches show "Biometric attendance is disabled"                                                     | Check **Biometric devices** in Attendance setup → Rules                                                                                                                                        |
| Punches show "No class in the check-in window"                                                      | None of the student's classes in the device's branch covers the punch time. Check the timetable, the device's branch and the check-in window                                                   |
| Punches show "Out punch"                                                                            | The device recorded a check-out state. Turn off the device's automatic punch-state switch, or set the state to check-in                                                                        |
| Punches show "Punch time is in the future; check the device clock", or times are off by whole hours | The device clock or zone is wrong. Set **Device clock time zone** if the device runs in another zone, then press **Sync clock**                                                                |
| 429 responses                                                                                       | Many devices or users behind one IP. Raise `RATE_LIMIT_ADMS_PER_MIN` (and `RATE_LIMIT_API_PER_MIN`)                                                                                            |
| Commands stay pending, then expire                                                                  | The device isn't checking for commands: it is offline, or its firmware ignores the command                                                                                                     |
| **Device users** is empty                                                                           | The device hasn't uploaded its users yet. Press **Re-read users**. PINs also appear once they punch                                                                                            |

To check the server from the site, request the handshake with the device's serial. A registered, active device gets
a reply starting with `GET OPTION FROM:`; any other serial gets a 403.

```sh
curl -i 'https://app.example.com/iclock/cdata?SN=<serial>&options=all'
```

## Testing without a device

Tests and CI never use real devices. [`biometric-adms.test.ts`](../../backend/test/biometric-adms.test.ts) replays
recorded device requests from [`backend/test/fixtures/adms/`](../../backend/test/fixtures/adms) at the HTTP
boundary.

To try a local API by hand, register an ADMS device with serial `TEST0001` and turn on **Allow plain HTTP**, because
the local API runs without HTTPS. Then:

```sh
API=http://localhost:4000
SN=TEST0001
curl -s "$API/iclock/cdata?SN=$SN&options=all&pushver=2.4.1"                 # handshake
printf '1001\t%s\t0\t1\t0\t0\t0\n' "$(date '+%Y-%m-%d %H:%M:%S')" |
  curl -s --data-binary @- "$API/iclock/cdata?SN=$SN&table=ATTLOG&Stamp=1"  # one punch, PIN 1001
curl -s "$API/iclock/getrequest?SN=$SN"                                      # queued commands
```

PIN 1001 then appears under **Device users**, and mapping it to a student applies the punch.

## What only a real device can verify

The fixtures follow the published ADMS protocol and recorded requests, but these depend on the firmware:

- **Handshake:** whether the device accepts `TimeZone` in hours or minutes, and whether **Sync clock**
  (`RELOAD OPTIONS`) sets its clock from the server's `Date` header.
- **Transport:** HTTPS and certificate checks on the device, the `.aspx` path variants, and routing through nginx's
  default server for devices set up with an IP address.
- **User lists:** the exact `OPERLOG` and `USERINFO` formats (with or without the `USER` prefix), which field of an
  operation record holds the PIN, differences in eSSL firmware, and names in non-UTF-8 encodings.
- **Commands:** the return codes, whether `CHECK` re-uploads every user, and where `DATA QUERY` results arrive.
- **Uploads:** older firmware's handling of the `TransFlag` list, real compressed data packets, batch sizes against
  the caps, and retry behaviour after a refusal.
- **Site network:** the source address seen behind the site's NAT, and punch states when the device switches them
  automatically.

Not supported: `/iclock/exchange` and PUSH 3.x registration and encryption, and photo or template uploads.
