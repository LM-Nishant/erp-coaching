import { reactive } from 'vue';
import { io, type Socket } from 'socket.io-client';
import {
  LIVE_CLIENT_EVENTS as C,
  LIVE_SERVER_EVENTS as S,
  type LiveChatMessageDto,
  type LiveJoinInfo,
  type LiveParticipantDto,
  type LivePollDto,
  type LiveQuestionDto,
  type LiveRole,
  type LiveRoomState,
  type LiveSessionDto,
  type LiveUserRef,
  type RtcSignal,
  type WhiteboardStroke,
} from '@erp/shared';
import { API_URL, ApiError } from '@/core/api';
import { loadSession } from '@/core/token-storage';
import { liveApi } from '../api';

type AckResult<T> = { ok: true; data?: T } | { ok: false; error: { code: string; message: string } };

export interface LiveRoom {
  connected: boolean;
  joined: boolean;
  ended: boolean;
  error: string | null;
  session: LiveSessionDto | null;
  me: (LiveUserRef & { role: LiveRole }) | null;
  hostOnline: boolean;
  participants: LiveParticipantDto[];
  chat: LiveChatMessageDto[];
  questions: LiveQuestionDto[];
  polls: LivePollDto[];
  hands: LiveUserRef[];
  speakers: LiveUserRef[];
  screenSharing: boolean;
  whiteboard: { visible: boolean; strokes: WhiteboardStroke[] };
}

const upsert = <T extends { id: number }>(list: T[], item: T, merge?: (old: T, item: T) => T) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) list.push(item);
  else list.splice(i, 1, merge ? merge(list[i], item) : item);
};

/**
 * Connects to the live-class Socket.IO namespace with the user's normal access token (re-read on
 * every reconnect, so refreshed tokens are picked up) and keeps a reactive copy of the room.
 */
export function useLiveSocket(sessionId: number, info: LiveJoinInfo) {
  const room = reactive<LiveRoom>({
    connected: false,
    joined: false,
    ended: false,
    error: null,
    session: null,
    me: null,
    hostOnline: false,
    participants: [],
    chat: [],
    questions: [],
    polls: [],
    hands: [],
    speakers: [],
    screenSharing: false,
    whiteboard: { visible: false, strokes: [] },
  });
  const rtcHandlers = new Set<(s: RtcSignal & { from: number }) => void>();
  const joinHandlers = new Set<(state: LiveRoomState) => void>();

  const socket: Socket = io(`${API_URL}${info.socketNamespace}`, {
    path: info.socketPath,
    transports: ['websocket', 'polling'],
    auth: (cb) => {
      void loadSession().then((s) => cb({ token: s?.accessToken, branchId: s?.branchId ?? null }));
    },
  });

  const emit = <T = unknown>(event: string, payload: unknown = {}) =>
    new Promise<T>((resolve, reject) => {
      socket.timeout(15000).emit(event, payload, (err: Error | null, res: AckResult<T>) => {
        if (err) return reject(new ApiError(0, 'TIMEOUT', 'The live class is not responding'));
        if (!res.ok) return reject(new ApiError(400, res.error.code, res.error.message));
        resolve(res.data as T);
      });
    });

  async function join() {
    try {
      const state = await emit<LiveRoomState>(C.join, { sessionId });
      Object.assign(room, {
        joined: true,
        error: null,
        session: state.session,
        me: state.me,
        hostOnline: state.hostOnline,
        participants: state.participants,
        chat: state.chat,
        questions: state.questions,
        polls: state.polls,
        hands: state.raisedHands,
        speakers: state.speakers,
        screenSharing: state.screenSharing,
        whiteboard: state.whiteboard,
      });
      joinHandlers.forEach((h) => h(state));
    } catch (e) {
      room.error = (e as Error).message;
      if ((e as ApiError).code === 'NOT_LIVE') room.ended = true;
    }
  }

  socket.on('connect', () => {
    room.connected = true;
    void join();
  });
  socket.on('disconnect', (reason) => {
    room.connected = false;
    room.joined = false;
    // Dropped by the server (device signed out or idle, subscription suspended…): an API call surfaces why
    // through the usual 401 / 402 handling, and reconnects when access is fine again.
    if (reason === 'io server disconnect')
      void liveApi.get(sessionId).then(
        () => socket.connect(),
        () => {},
      );
  });
  socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
    room.connected = false;
    room.error = err.message;
    // An expired access token: any API call refreshes it, then retry the handshake.
    if (err.data?.code && /UNAUTHENTICATED|TOKEN/.test(err.data.code))
      void liveApi.get(sessionId).then(
        () => socket.connect(),
        () => {},
      );
  });

  socket.on(S.participantJoined, (u: LiveUserRef & { role: LiveRole }) => {
    const p = room.participants.find((x) => x.userId === u.id);
    if (p) p.online = true;
    else
      room.participants.push({
        userId: u.id,
        name: u.name,
        role: u.role,
        firstJoinedAt: new Date().toISOString(),
        lastJoinedAt: new Date().toISOString(),
        lastLeftAt: null,
        totalSeconds: 0,
        joinCount: 1,
        online: true,
      });
  });
  socket.on(S.participantLeft, ({ userId }: { userId: number }) => {
    const p = room.participants.find((x) => x.userId === userId);
    if (p) p.online = false;
  });
  socket.on(S.hostState, ({ online }: { online: boolean }) => (room.hostOnline = online));
  socket.on(S.chatMessage, (m: LiveChatMessageDto) => upsert(room.chat, m));
  socket.on(S.qaUpdate, (q: LiveQuestionDto) =>
    upsert(room.questions, q, (old, n) => ({ ...n, upvotedByMe: n.upvotedByMe ?? old.upvotedByMe })),
  );
  socket.on(S.pollUpdate, (p: LivePollDto) =>
    upsert(room.polls, p, (old, n) => ({ ...n, myVote: n.myVote === undefined ? old.myVote : n.myVote })),
  );
  socket.on(S.handsUpdate, (h: LiveUserRef[]) => (room.hands = h));
  socket.on(S.speakersUpdate, (s: LiveUserRef[]) => (room.speakers = s));
  socket.on(S.screenState, ({ sharing }: { sharing: boolean }) => (room.screenSharing = sharing));
  socket.on(S.wbStroke, (s: WhiteboardStroke) => room.whiteboard.strokes.push(s));
  socket.on(S.wbUndo, ({ id }: { id: string }) => {
    room.whiteboard.strokes = room.whiteboard.strokes.filter((s) => s.id !== id);
  });
  socket.on(S.wbClear, () => (room.whiteboard.strokes = []));
  socket.on(S.wbVisible, ({ visible }: { visible: boolean }) => (room.whiteboard.visible = visible));
  socket.on(S.sessionEnded, () => {
    room.ended = true;
    room.joined = false;
  });
  socket.on(S.rtcSignal, (s: RtcSignal & { from: number }) => rtcHandlers.forEach((h) => h(s)));

  const replaceById = <T extends { id: number }>(list: T[], item: T) => upsert(list, item);

  return {
    room,
    socket,
    emit,
    onSignal: (h: (s: RtcSignal & { from: number }) => void) => rtcHandlers.add(h),
    onJoined: (h: (state: LiveRoomState) => void) => joinHandlers.add(h),
    signal: (s: RtcSignal) => emit(C.rtcSignal, s),
    sendChat: (body: string) => emit<LiveChatMessageDto>(C.chatSend, { body }),
    ask: (body: string) => emit<LiveQuestionDto>(C.qaAsk, { body }),
    upvote: async (id: number) =>
      replaceById(room.questions, await emit<LiveQuestionDto>(C.qaUpvote, { id })),
    answer: (id: number, answered: boolean) => emit(C.qaAnswer, { id, answered }),
    createPoll: (question: string, options: string[]) => emit(C.pollCreate, { question, options }),
    vote: async (id: number, optionIndex: number) =>
      replaceById(room.polls, await emit<LivePollDto>(C.pollVote, { id, optionIndex })),
    closePoll: (id: number) => emit(C.pollClose, { id }),
    raiseHand: () => emit(C.handRaise),
    lowerHand: (userId?: number) => emit(C.handLower, userId ? { userId } : {}),
    grantMic: (userId: number) => emit(C.micGrant, { userId }),
    revokeMic: (userId: number) => emit(C.micRevoke, { userId }),
    setScreen: (sharing: boolean) => emit(C.screenState, { sharing }),
    stroke: (s: WhiteboardStroke) => {
      room.whiteboard.strokes.push(s);
      return emit(C.wbStroke, s);
    },
    undo: () => {
      const last = room.whiteboard.strokes.pop();
      return last ? emit(C.wbUndo, { id: last.id }) : Promise.resolve();
    },
    clearBoard: () => {
      room.whiteboard.strokes = [];
      return emit(C.wbClear);
    },
    setBoardVisible: (visible: boolean) => {
      room.whiteboard.visible = visible;
      return emit(C.wbVisible, { visible });
    },
    close: () => {
      socket.emit(C.leave, {}, () => {});
      socket.disconnect();
    },
  };
}

export type LiveSocket = ReturnType<typeof useLiveSocket>;
