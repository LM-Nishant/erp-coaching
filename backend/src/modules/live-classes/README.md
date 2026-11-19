# Live classroom (`live-classes`)

Spec §4.9 and the "Live class" workflow. Teachers schedule live sessions for a batch, optionally linked to an academics
class session. Enrolled students join a one-way teacher stream with chat, Q&A, polls, raise-hand/permitted microphone,
screen share and a whiteboard. The class is recorded automatically and attendance comes from join/leave tracking.

## Pieces

| File                            | Role                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `live-classes.service.ts`       | Sessions, access control, participation, chat/Q&A/polls persistence, recordings           |
| `live-classes.routes.ts`        | REST under `/api/live-classes`                                                            |
| `realtime.ts`                   | Socket.IO server (path `/api/live-classes/socket.io`, namespace `/live`), in-memory rooms |
| `live-events.ts` / `api.ts`     | Cross-module events and helpers (import only `api.ts` from other modules)                 |
| `provider-webhooks.ts`          | Signed provider webhooks (attendance, recordings), admin status and connection test       |
| `infrastructure/streaming/`     | `StreamingProvider` adapters: `DevWebRtcStreamingProvider` (default, `mock`), LiveKit     |
| `app/src/modules/live-classes/` | Class list, detail, teacher console + student view (`LiveRoomPage.vue`)                   |

Socket.IO is attached through the generic `attachServer(server)` module hook (`shared/module.ts`), called by
`server.ts` after `listen()`. Tests attach it to their own HTTP server.

## Access

- Host: the session's teacher. Only the host can start the class, publish media, draw and upload recordings.
- Moderator: users with `live-classes.configure` (branch admins) in an allowed branch, and the batch's other teachers.
  They can end the class, mark Q&A answered, run polls and grant mics. They can watch, but they can't start the class.
- Student: active enrolment in the batch (academics roster, **student user id**).
- Paid courses: `setLiveEntitlementProvider(fn)` (from `api.ts`) adds a check before a student gets a join token
  (`403 LIVE_NOT_ENTITLED`). The default allows. Fees registers it so a course with an active fee structure needs the
  fee entitlement or an LMS manual grant.
- Everyone else gets 404. Join tokens (`POST /:id/join`) are issued only to these roles while the session is `live`.
  A join token is bound to the device that asked for it and lasts until 30 minutes after the scheduled end (at least
  15 minutes, at most 4 hours; LiveKit's last 15 minutes and LiveKit renews them while connected). Clients ask for a
  new one before `expiresAt`.
- The socket handshake reuses the HTTP `authenticate` middleware (access token + `branchId`), so tenant, branch,
  device-session and module checks are identical to REST. A device that signed out is refused (`401 SIGNED_OUT`) even
  though its access token has not expired yet. Every room action re-checks the role.
- Open sockets are re-checked every minute and when the institute's subscription or status changes: a revoked, idle or
  signed-out device, an inactive user or institute, a suspended subscription or a lost permission drops them. A device
  that signs out or is revoked is dropped within seconds by the device event's job (`dropDevice` in `realtime.ts`):
  its sockets, and its connections to the provider's media rooms.

## Dev WebRTC transport (default, no vendor keys)

`transport: 'socket-webrtc'`: media flows peer-to-peer and the socket only relays SDP/ICE (`rtc:signal`), and only
between the host and others. The teacher's browser is the hub. It keeps one `RTCPeerConnection` per student with three
fixed transceivers:

- video, sendonly: the camera or screen, swapped with `replaceTrack`
- audio, sendonly: the teacher's mic
- audio, sendrecv: the speaker slot

When the teacher grants a student the mic, that student's audio arrives on the speaker slot and the teacher relays it
to everyone else. One speaker at a time; no renegotiation is needed. A student asks for an offer by sending an empty
signal ("hello") after joining or when the host comes online.

This suits demos and small classes, roughly 15–25 viewers depending on the teacher's uplink. Use LiveKit (below) for
real classes. STUN servers come from `iceServers()`. Add a TURN server there for viewers behind symmetric NAT.

**Recording in dev**: `startRecording` returns `client-upload`. The teacher's client draws a 1280×720 composite (video,
or whiteboard plus camera picture-in-picture) and mixes the teacher and speaking-student audio. It records with
`MediaRecorder` and uploads each part (rotated every 30 min, plus on End) to `POST /:id/recordings`. Files go through
the storage service (`saveUploadedFile`). Mobile WebViews without `MediaRecorder`/`captureStream` show a notice instead.

## LiveKit (`STREAMING_PROVIDER=livekit`)

`infrastructure/streaming/livekit.provider.ts` talks to LiveKit's server API (Twirp JSON over `fetch`; self-hosted or
LiveKit Cloud) and signs join tokens with per-role grants. LiveKit's signed webhooks arrive at
`POST /api/live-classes/public/livekit/webhook` (`provider-webhooks.ts`): participant joins and leaves become
`live_participants` rows (source `provider`), `room_finished` closes open visits, and `egress_ended` enqueues
`live-classes.import-recording`. Events are idempotent through `live_webhook_events`. Mic grants call
`setParticipantPublish` (LiveKit `UpdateParticipant`). Join tokens carry the device id in the participant metadata
(`{ role, deviceId }`; the identity is `user-<id>`). `removeParticipant` (LiveKit `GetParticipant`, then
`RemoveParticipant` if the metadata names that device) drops a device's connection, and the webhook removes a join
reported from a device that is no longer signed in (`isDeviceSignedIn`) without recording it. The app uses
`livekit-client` (`useLiveKitMedia.ts`) for `transport: 'vendor-sdk'`. Setup, ports and operations: [docs/integrations/live-streaming.md](../../../../docs/integrations/live-streaming.md).

## Plugging in another provider (100ms, Agora, Jitsi…)

1. Implement `StreamingProvider` (`infrastructure/streaming/types.ts`) in `infrastructure/streaming/<vendor>.provider.ts`
   (LiveKit is the reference):
   - `transport = 'vendor-sdk'`.
   - `createRoom`: create the vendor room.
   - `issueJoinToken`: mint a vendor token with publish rights for `host`/`speaker` and subscribe-only for `viewer`, and
     return the SFU `url`. Use `ttlSeconds` as given (or a shorter cap if the vendor renews tokens of connected
     participants), and put `deviceId` in the participant identity or metadata the participant can't change.
   - `removeParticipant` (optional, but without it a vendor connection lasts until it leaves or the class ends):
     vendors check the token only when a participant connects, so implement it to disconnect the user's connection
     made with a token of `deviceId`. `dropDevice` calls it when the device signs out or is
     revoked, and the socket re-check for the seats of the sockets it drops. Report `deviceId` on webhook participant
     events too, so joins from signed-out devices are refused.
   - `verifyJoinToken` (optional): check the signature and expiry of a token the adapter issued. A media relay or
     webhook calls `verifyJoinCredentials` (from `api.ts`), which also checks that the device is still signed in.
   - `startRecording`: start vendor egress/composite recording and return `{ mode: 'provider' }`.
   - `endRoom`: close the room and return finished files as `ProviderRecording` (`ref` is used for idempotency).
   - Optional: `setParticipantPublish` (live mic grants), `reportsPresence` + `parseWebhook` (attendance and
     recordings from webhooks), `listRecordings`/`fetchRecording`/`discardRecording` (catch-up, private downloads,
     clean-up), `testConnection`/`describe` (the admin card).
2. Add the key to the `STREAMING_PROVIDER` enum in `infrastructure/config` and return the adapter from
   `getStreamingProvider()`. Keep secrets in env vars.
3. Provider recordings are imported by the `live-classes.import-recording` job. It downloads `downloadUrl` (or calls
   `fetchRecording`), stores the file and emits `live.recording.ready`. For webhooks, implement `parseWebhook` (verify
   the vendor signature): the public route `/api/live-classes/public/:provider/webhook` applies the returned events
   idempotently.
4. App: `LiveRoomPage.vue` checks `joinInfo.transport`. For `vendor-sdk`, mount the vendor SDK component with
   `joinInfo.url` + `joinInfo.token` in place of `useTeacherMedia`/`useViewerMedia`, and fetch new credentials before
   `joinInfo.expiresAt` so reconnects keep working. Chat, Q&A, polls, hands, whiteboard and attendance still use the
   live socket, and mic grants map to the vendor's publish permission.

## Socket protocol

Event names are in `packages/shared/src/live-classes.ts` (`LIVE_CLIENT_EVENTS`, `LIVE_SERVER_EVENTS`).

- Every client event takes an ack: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- `live:join { sessionId }` returns `LiveRoomState`. Clients re-join after every reconnect.
- Chat is throttled per user. Whiteboard strokes use 0..1 normalised points, and the room keeps the last 2000.
- A user counts as left when their last socket disconnects. Join/leave times are persisted to `live_participants`.

**Scaling out**: room state (hands, speakers, whiteboard) lives in memory on one node. For several API nodes:

- add `@socket.io/redis-adapter`
- enable sticky sessions for the socket path
- move the `rooms` map to Redis

## Notifications

- `live-classes.scheduled`: batch members (`batchMembersOf`) and the students' guardians.
- `live-classes.starting`: batch members, when the teacher goes live.
- `live-classes.recording-ready`: batch members, after each recording part is stored.

## Cross-module wiring

Other modules subscribe from their own `integrations.ts`/`onReady`. Listeners run in a background job with the
institute's system context and must be idempotent, because a failed dispatch is retried.

```ts
import { onLiveSessionEnded, onLiveRecordingReady, listBatchRecordings } from '../live-classes/api';

// attendance: mark live attendance (ids are student *user* ids)
onLiveSessionEnded('attendance', async (e) => {
  // e.participants[] { userId, role, firstJoinedAt, lastLeftAt, totalSeconds, joinCount }, e.absentStudentUserIds
});

// LMS: attach the recording to the course/batch content
onLiveRecordingReady('lms', async (e) => {
  // e.recordingId, e.fileId, e.batchId, e.courseId, e.subjectId, e.classSessionId, e.title, e.durationSeconds
});
```

`onLiveSessionStarted` is also available. `listBatchRecordings(batchId)` and `getRecording(id)` read recordings
directly.
