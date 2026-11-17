/** Live classroom (spec §4.9): shared constants, DTOs and Socket.IO event contract. */

export const LIVE_SESSION_STATUSES = ['scheduled', 'live', 'ended', 'cancelled'] as const;
export type LiveSessionStatus = (typeof LIVE_SESSION_STATUSES)[number];

/** `host` = the class teacher (streams), `moderator` = other batch teachers / managers, `student` = viewer. */
export const LIVE_ROLES = ['host', 'moderator', 'student'] as const;
export type LiveRole = (typeof LIVE_ROLES)[number];

/** Socket.IO path on the API server (module-prefixed so proxies can route it with the API). */
export const LIVE_SOCKET_PATH = '/api/live-classes/socket.io';
export const LIVE_SOCKET_NAMESPACE = '/live';

export interface LiveUserRef {
  id: number;
  name: string;
}

export interface LiveSessionDto {
  id: number;
  branchId: number;
  batchId: number;
  batchName: string | null;
  courseId: number | null;
  subjectId: number | null;
  classSessionId: number | null;
  teacher: LiveUserRef;
  title: string;
  description: string | null;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: LiveSessionStatus;
  startedAt: string | null;
  endedAt: string | null;
  recordingEnabled: boolean;
  provider: string;
  /** Role of the current user in this class (null = not a participant, e.g. a manager not yet joined). */
  myRole: LiveRole | null;
  recordingCount?: number;
}

export interface CreateLiveSessionInput {
  /** Link to an academics class session: batch, teacher, subject and times are taken from it. */
  classSessionId?: number;
  batchId?: number;
  subjectId?: number | null;
  teacherUserId?: number;
  title?: string;
  description?: string | null;
  scheduledStartAt?: string;
  durationMinutes?: number;
  recordingEnabled?: boolean;
}

export type UpdateLiveSessionInput = Partial<
  Pick<
    CreateLiveSessionInput,
    'title' | 'description' | 'scheduledStartAt' | 'durationMinutes' | 'recordingEnabled'
  >
>;

/** Returned by `POST /live-classes/:id/join`: provider media credentials + socket coordinates. */
export interface LiveJoinInfo {
  sessionId: number;
  role: LiveRole;
  provider: string;
  /** `socket-webrtc`: media is negotiated peer-to-peer over the live socket (dev adapter). `vendor-sdk`: use `url` + `token` with the vendor SDK. */
  transport: 'socket-webrtc' | 'vendor-sdk';
  roomId: string;
  token: string;
  url: string | null;
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  socketPath: string;
  socketNamespace: string;
  expiresAt: string;
}

export interface LiveParticipantDto {
  userId: number;
  name: string;
  role: LiveRole;
  firstJoinedAt: string | null;
  lastJoinedAt: string | null;
  lastLeftAt: string | null;
  totalSeconds: number;
  joinCount: number;
  online: boolean;
}

export interface LiveChatMessageDto {
  id: number;
  user: LiveUserRef;
  body: string;
  createdAt: string;
}

export interface LiveQuestionDto {
  id: number;
  user: LiveUserRef;
  body: string;
  upvotes: number;
  upvotedByMe: boolean;
  isAnswered: boolean;
  createdAt: string;
}

export interface LivePollDto {
  id: number;
  question: string;
  options: string[];
  status: 'open' | 'closed';
  /** Votes per option (same order as `options`). */
  counts: number[];
  totalVotes: number;
  /** Option index the current user voted for. */
  myVote: number | null;
  createdAt: string;
}

export interface LiveRecordingDto {
  id: number;
  liveSessionId: number;
  batchId: number;
  courseId: number | null;
  title: string;
  fileId: number;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  source: 'provider' | 'client-upload';
  createdAt: string;
}

/* ------------------------------------------------------------ whiteboard */

export interface WhiteboardStroke {
  id: string;
  tool: 'pen' | 'eraser';
  color: string;
  /** Line width in pixels of a 1280×720 board (0.5–80). */
  width: number;
  /** Points normalised to 0..1 of the board, flattened [x0, y0, x1, y1, …]. */
  points: number[];
}

/* ------------------------------------------------------------ socket contract */

/** Snapshot sent in the `live:join` ack and after reconnects. */
export interface LiveRoomState {
  session: LiveSessionDto;
  me: LiveUserRef & { role: LiveRole };
  hostOnline: boolean;
  participants: LiveParticipantDto[];
  chat: LiveChatMessageDto[];
  questions: LiveQuestionDto[];
  polls: LivePollDto[];
  raisedHands: LiveUserRef[];
  /** Students currently allowed to use their microphone. */
  speakers: LiveUserRef[];
  screenSharing: boolean;
  whiteboard: { visible: boolean; strokes: WhiteboardStroke[] };
}

export type LiveAck<T = unknown> = (
  res: { ok: true; data?: T } | { ok: false; error: { code: string; message: string } },
) => void;

export interface RtcSignal {
  /** Target user id (teacher ↔ student only). */
  to: number;
  from?: number;
  description?: { type: string; sdp?: string };
  candidate?: unknown;
}

/** Client → server events. Every event takes an ack callback. */
export const LIVE_CLIENT_EVENTS = {
  join: 'live:join',
  leave: 'live:leave',
  chatSend: 'chat:send',
  qaAsk: 'qa:ask',
  qaUpvote: 'qa:upvote',
  qaAnswer: 'qa:answer',
  pollCreate: 'poll:create',
  pollVote: 'poll:vote',
  pollClose: 'poll:close',
  handRaise: 'hand:raise',
  handLower: 'hand:lower',
  micGrant: 'mic:grant',
  micRevoke: 'mic:revoke',
  rtcSignal: 'rtc:signal',
  screenState: 'screen:state',
  wbStroke: 'wb:stroke',
  wbUndo: 'wb:undo',
  wbClear: 'wb:clear',
  wbVisible: 'wb:visible',
} as const;

/** Server → client events. */
export const LIVE_SERVER_EVENTS = {
  participantJoined: 'participant:joined',
  participantLeft: 'participant:left',
  hostState: 'host:state',
  chatMessage: 'chat:message',
  qaUpdate: 'qa:update',
  pollUpdate: 'poll:update',
  handsUpdate: 'hands:update',
  speakersUpdate: 'speakers:update',
  rtcSignal: 'rtc:signal',
  screenState: 'screen:state',
  wbStroke: 'wb:stroke',
  wbUndo: 'wb:undo',
  wbClear: 'wb:clear',
  wbVisible: 'wb:visible',
  sessionEnded: 'session:ended',
} as const;
