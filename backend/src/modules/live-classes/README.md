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
| `infrastructure/streaming/`     | `StreamingProvider` adapter; `DevWebRtcStreamingProvider` is the default (`mock`)         |
| `app/src/modules/live-classes/` | Class list, detail, teacher console + student view (`LiveRoomPage.vue`)                   |

Socket.IO is attached through the generic `attachServer(server)` module hook (`shared/module.ts`), called by
`server.ts` after `listen()`. Tests attach it to their own HTTP server.

## Access

- Host: the session's teacher. Only the host can start the class, publish media, draw and upload recordings.
- Moderator: users with `live-classes.configure` (branch admins) in an allowed branch. They can end the class, mark Q&A
  answered, run polls and grant mics. They can watch, but they can't start the class.
- Student: active enrolment in the batch (academics roster, **student user id**).
- Everyone else gets 404. Join tokens (`POST /:id/join`) are issued only to these roles while the session is `live`.
- The socket handshake reuses the HTTP `authenticate` middleware (access token + `branchId`), so tenant, branch,
  device-session and module checks are identical to REST. Every room action re-checks the role.

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

This suits demos and small classes, roughly 15–25 viewers depending on the teacher's uplink. Use a vendor SFU for real
classes. STUN servers come from `iceServers()`. Add a TURN server there for viewers behind symmetric NAT.

**Recording in dev**: `startRecording` returns `client-upload`. The teacher's client draws a 1280×720 composite (video,
or whiteboard plus camera picture-in-picture) and mixes the teacher and speaking-student audio. It records with
`MediaRecorder` and uploads each part (rotated every 30 min, plus on End) to `POST /:id/recordings`. Files go through
the storage service (`saveUploadedFile`). Mobile WebViews without `MediaRecorder`/`captureStream` show a notice instead.

## Plugging in a real provider (LiveKit, 100ms, Agora, Jitsi…)

1. Implement `StreamingProvider` (`infrastructure/streaming/types.ts`) in `infrastructure/streaming/<vendor>.provider.ts`:
   - `transport = 'vendor-sdk'`.
   - `createRoom`: create the vendor room.
   - `issueJoinToken`: mint a vendor token with publish rights for `host`/`speaker` and subscribe-only for `viewer`, and
     return the SFU `url`.
   - `startRecording`: start vendor egress/composite recording and return `{ mode: 'provider' }`.
   - `endRoom`: close the room and return finished files as `ProviderRecording` (`ref` is used for idempotency).
2. Add the key to the `STREAMING_PROVIDER` enum in `infrastructure/config` and return the adapter from
   `getStreamingProvider()`. Keep secrets in env vars.
3. Provider recordings are imported by the `live-classes.import-recording` job. It downloads `downloadUrl`, stores the
   file and emits `live.recording.ready`. If files arrive later through a webhook, add a public route under
   `/public/live-classes/...` that verifies the vendor signature and enqueues the same job.
4. App: `LiveRoomPage.vue` checks `joinInfo.transport`. For `vendor-sdk`, mount the vendor SDK component with
   `joinInfo.url` + `joinInfo.token` in place of `useTeacherMedia`/`useViewerMedia`. Chat, Q&A, polls, hands, whiteboard
   and attendance still use the live socket, and mic grants map to the vendor's publish permission.

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
