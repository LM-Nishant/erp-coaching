import type { LiveUserRef, WhiteboardStroke } from '@erp/shared';
import { logger } from '../../infrastructure/logger';
import { getRedis, type RedisClient } from '../../infrastructure/redis';
import { AppError } from '../../shared/errors';

/**
 * Live-room state that isn't persisted: raised hands, speakers, screen sharing and the whiteboard.
 * It lives in Redis when REDIS_URL is set, so every API instance sees the same room; otherwise in
 * this process. Who is online comes from the room's sockets, not from here.
 */
export interface RoomExtras {
  hands: LiveUserRef[];
  speakers: LiveUserRef[];
  screenSharing: boolean;
  whiteboard: { visible: boolean; strokes: WhiteboardStroke[] };
}

export interface RoomStore {
  get(room: string): Promise<RoomExtras>;
  /** Returns the hands after the change, oldest first. */
  raiseHand(room: string, user: LiveUserRef): Promise<LiveUserRef[]>;
  lowerHand(room: string, userId: number): Promise<{ removed: boolean; hands: LiveUserRef[] }>;
  /**
   * One student speaks at a time: replaces the speakers and lowers the speaker's hand. `previous` lists the
   * speakers it replaced, whose media-server publish permission the caller revokes.
   */
  grantMic(
    room: string,
    user: LiveUserRef,
  ): Promise<Pick<RoomExtras, 'hands' | 'speakers'> & { previous: LiveUserRef[] }>;
  revokeMic(room: string, userId: number): Promise<{ removed: boolean; speakers: LiveUserRef[] }>;
  setScreenSharing(room: string, sharing: boolean): Promise<void>;
  addStroke(room: string, stroke: WhiteboardStroke): Promise<void>;
  /** Removes the stroke (the last one without an id); returns its id, or null. */
  undoStroke(room: string, strokeId?: string): Promise<string | null>;
  clearStrokes(room: string): Promise<void>;
  setWhiteboardVisible(room: string, visible: boolean): Promise<void>;
  hasStrokes(room: string): Promise<boolean>;
  drop(room: string): Promise<void>;
}

export const MAX_STROKES = 2000;

type Entry = LiveUserRef & { at: number };
const byTime = (a: Entry, b: Entry) => a.at - b.at;
const ref = ({ at: _at, ...user }: Entry): LiveUserRef => user;

class MemoryRoomStore implements RoomStore {
  private rooms = new Map<
    string,
    {
      hands: Map<number, Entry>;
      speakers: Map<number, Entry>;
      screenSharing: boolean;
      visible: boolean;
      strokes: WhiteboardStroke[];
    }
  >();

  private room(name: string) {
    let r = this.rooms.get(name);
    if (!r) {
      r = { hands: new Map(), speakers: new Map(), screenSharing: false, visible: false, strokes: [] };
      this.rooms.set(name, r);
    }
    return r;
  }

  private static list(m: Map<number, Entry>) {
    return [...m.values()].sort(byTime).map(ref);
  }

  async get(name: string): Promise<RoomExtras> {
    const r = this.room(name);
    return {
      hands: MemoryRoomStore.list(r.hands),
      speakers: MemoryRoomStore.list(r.speakers),
      screenSharing: r.screenSharing,
      whiteboard: { visible: r.visible, strokes: [...r.strokes] },
    };
  }

  async raiseHand(name: string, user: LiveUserRef) {
    const r = this.room(name);
    if (!r.hands.has(user.id)) r.hands.set(user.id, { ...user, at: Date.now() });
    return MemoryRoomStore.list(r.hands);
  }

  async lowerHand(name: string, userId: number) {
    const r = this.room(name);
    const removed = r.hands.delete(userId);
    return { removed, hands: MemoryRoomStore.list(r.hands) };
  }

  async grantMic(name: string, user: LiveUserRef) {
    const r = this.room(name);
    const previous = MemoryRoomStore.list(r.speakers);
    r.speakers.clear();
    r.speakers.set(user.id, { ...user, at: Date.now() });
    r.hands.delete(user.id);
    return { hands: MemoryRoomStore.list(r.hands), speakers: MemoryRoomStore.list(r.speakers), previous };
  }

  async revokeMic(name: string, userId: number) {
    const r = this.room(name);
    const removed = r.speakers.delete(userId);
    return { removed, speakers: MemoryRoomStore.list(r.speakers) };
  }

  async setScreenSharing(name: string, sharing: boolean) {
    this.room(name).screenSharing = sharing;
  }

  async addStroke(name: string, stroke: WhiteboardStroke) {
    const r = this.room(name);
    r.strokes.push(stroke);
    if (r.strokes.length > MAX_STROKES) r.strokes.shift();
  }

  async undoStroke(name: string, strokeId?: string) {
    const list = this.room(name).strokes;
    const idx = strokeId ? list.findIndex((s) => s.id === strokeId) : list.length - 1;
    return idx >= 0 ? list.splice(idx, 1)[0].id : null;
  }

  async clearStrokes(name: string) {
    this.room(name).strokes = [];
  }

  async setWhiteboardVisible(name: string, visible: boolean) {
    this.room(name).visible = visible;
  }

  async hasStrokes(name: string) {
    return !!this.rooms.get(name)?.strokes.length;
  }

  async drop(name: string) {
    this.rooms.delete(name);
  }
}

/** A class never runs this long; keys expire after it even if a room is never dropped. */
const TTL_SECONDS = 12 * 3600;

class RedisRoomStore implements RoomStore {
  constructor(private readonly redis: RedisClient) {}

  private keys(room: string) {
    const base = `live:${room}`;
    return {
      hands: `${base}:hands`,
      speakers: `${base}:speakers`,
      flags: `${base}:flags`,
      strokes: `${base}:strokes`,
    };
  }

  private static list(hash: Record<string, string>) {
    return Object.values(hash)
      .map((v) => JSON.parse(v) as Entry)
      .sort(byTime)
      .map(ref);
  }

  private async touch(room: string) {
    const k = this.keys(room);
    await this.redis
      .multi()
      .expire(k.hands, TTL_SECONDS)
      .expire(k.speakers, TTL_SECONDS)
      .expire(k.flags, TTL_SECONDS)
      .expire(k.strokes, TTL_SECONDS)
      .exec();
  }

  async get(room: string): Promise<RoomExtras> {
    const k = this.keys(room);
    const [hands, speakers, flags, strokes] = await Promise.all([
      this.redis.hGetAll(k.hands),
      this.redis.hGetAll(k.speakers),
      this.redis.hGetAll(k.flags),
      this.redis.lRange(k.strokes, 0, -1),
    ]);
    return {
      hands: RedisRoomStore.list(hands),
      speakers: RedisRoomStore.list(speakers),
      screenSharing: flags.screen === '1',
      whiteboard: {
        visible: flags.wb === '1',
        strokes: strokes.map((s) => JSON.parse(s) as WhiteboardStroke),
      },
    };
  }

  async raiseHand(room: string, user: LiveUserRef) {
    const k = this.keys(room);
    await this.redis.hSetNX(k.hands, String(user.id), JSON.stringify({ ...user, at: Date.now() }));
    await this.touch(room);
    return RedisRoomStore.list(await this.redis.hGetAll(k.hands));
  }

  async lowerHand(room: string, userId: number) {
    const k = this.keys(room);
    const removed = (await this.redis.hDel(k.hands, String(userId))) > 0;
    return { removed, hands: RedisRoomStore.list(await this.redis.hGetAll(k.hands)) };
  }

  async grantMic(room: string, user: LiveUserRef) {
    const k = this.keys(room);
    // Read and replace in one transaction, so a grant on another API instance can't slip in between.
    const [previous] = await this.redis
      .multi()
      .hGetAll(k.speakers)
      .del(k.speakers)
      .hSet(k.speakers, String(user.id), JSON.stringify({ ...user, at: Date.now() }))
      .hDel(k.hands, String(user.id))
      .exec();
    await this.touch(room);
    const [hands, speakers] = await Promise.all([
      this.redis.hGetAll(k.hands),
      this.redis.hGetAll(k.speakers),
    ]);
    return {
      hands: RedisRoomStore.list(hands),
      speakers: RedisRoomStore.list(speakers),
      previous: RedisRoomStore.list(previous as unknown as Record<string, string>),
    };
  }

  async revokeMic(room: string, userId: number) {
    const k = this.keys(room);
    const removed = (await this.redis.hDel(k.speakers, String(userId))) > 0;
    return { removed, speakers: RedisRoomStore.list(await this.redis.hGetAll(k.speakers)) };
  }

  async setScreenSharing(room: string, sharing: boolean) {
    await this.redis.hSet(this.keys(room).flags, 'screen', sharing ? '1' : '0');
    await this.touch(room);
  }

  async addStroke(room: string, stroke: WhiteboardStroke) {
    const k = this.keys(room);
    await this.redis
      .multi()
      .rPush(k.strokes, JSON.stringify(stroke))
      .lTrim(k.strokes, -MAX_STROKES, -1)
      .exec();
    await this.touch(room);
  }

  async undoStroke(room: string, strokeId?: string) {
    const k = this.keys(room);
    if (!strokeId) {
      const last = await this.redis.rPop(k.strokes);
      return last ? (JSON.parse(last) as WhiteboardStroke).id : null;
    }
    const raw = (await this.redis.lRange(k.strokes, 0, -1)).find(
      (s) => (JSON.parse(s) as WhiteboardStroke).id === strokeId,
    );
    if (!raw || !(await this.redis.lRem(k.strokes, 1, raw))) return null;
    return strokeId;
  }

  async clearStrokes(room: string) {
    await this.redis.del(this.keys(room).strokes);
  }

  async setWhiteboardVisible(room: string, visible: boolean) {
    await this.redis.hSet(this.keys(room).flags, 'wb', visible ? '1' : '0');
    await this.touch(room);
  }

  async hasStrokes(room: string) {
    return (await this.redis.lLen(this.keys(room).strokes)) > 0;
  }

  async drop(room: string) {
    const k = this.keys(room);
    await this.redis.del([k.hands, k.speakers, k.flags, k.strokes]);
  }
}

/**
 * While Redis is unreachable, the store's calls fail with a 503 that the class sees ("briefly unavailable")
 * and a warning at most once a minute, instead of an error log for every hand or stroke.
 */
function unavailableOnError(store: RoomStore): RoomStore {
  let warnedAt = 0;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (err) {
          if (Date.now() - warnedAt > 60_000) {
            warnedAt = Date.now();
            logger.warn({ err }, 'Live room state unavailable (Redis)');
          }
          throw new AppError(
            503,
            'LIVE_STATE_UNAVAILABLE',
            'This part of the class is briefly unavailable. Try again in a moment.',
          );
        }
      };
    },
  });
}

export function createRoomStore(): RoomStore {
  const redis = getRedis();
  return redis ? unavailableOnError(new RedisRoomStore(redis)) : new MemoryRoomStore();
}
