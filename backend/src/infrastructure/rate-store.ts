import {
  MemoryStore,
  type ClientRateLimitInfo,
  type IncrementResponse,
  type Options,
  type Store,
} from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { logger } from './logger';
import { getRedis, type RedisClient } from './redis';

/**
 * A rate-limit store that counts in Redis while it is reachable and in this process otherwise, so a
 * Redis outage degrades to per-instance limits instead of failing requests or dropping the limits.
 */
export class SharedStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private readonly memory = new MemoryStore();
  private redis?: RedisStore;
  private options?: Options;
  private warnedAt = 0;

  constructor(
    private readonly client: RedisClient,
    name: string,
  ) {
    this.prefix = `rl:${name}:`;
  }

  init(options: Options): void {
    this.options = options;
    this.memory.init(options);
  }

  private shared(): RedisStore | undefined {
    if (!this.client.isReady || !this.options) return undefined;
    if (!this.redis) {
      this.redis = new RedisStore({
        prefix: this.prefix,
        sendCommand: (...args: string[]) => this.client.sendCommand(args),
      });
      // Loads the Lua scripts; if that fails, the first command loads them again.
      this.redis.init(this.options).catch(() => undefined);
    }
    return this.redis;
  }

  private async run<T>(shared: (s: RedisStore) => Promise<T>, local: () => Promise<T> | T): Promise<T> {
    const s = this.shared();
    if (s) {
      try {
        return await shared(s);
      } catch (err) {
        if (Date.now() - this.warnedAt > 60_000) {
          this.warnedAt = Date.now();
          logger.warn({ err, store: this.prefix }, 'Redis rate-limit store failed; counting in memory');
        }
      }
    }
    return local();
  }

  get(key: string): Promise<ClientRateLimitInfo | undefined> {
    return this.run(
      (s) => s.get(key),
      () => this.memory.get(key),
    );
  }

  increment(key: string): Promise<IncrementResponse> {
    return this.run(
      (s) => s.increment(key),
      () => this.memory.increment(key),
    );
  }

  decrement(key: string): Promise<void> {
    return this.run(
      (s) => s.decrement(key),
      () => this.memory.decrement(key),
    );
  }

  async resetKey(key: string): Promise<void> {
    await Promise.all([
      this.run(
        (s) => s.resetKey(key),
        () => undefined,
      ),
      this.memory.resetKey(key),
    ]);
  }
}

/** The store for a limiter or counter: shared through Redis when REDIS_URL is set, else in memory. */
export function rateStore(name: string): Store {
  const redis = getRedis();
  return redis ? new SharedStore(redis, name) : new MemoryStore();
}

/**
 * A fixed-window counter outside express-rate-limit (e.g. OTP requests per mobile number), with the
 * same storage as the limiters.
 */
export function windowCounter(name: string, windowMs: number) {
  const store = rateStore(name);
  void store.init?.({ windowMs } as Options);
  return {
    /** Counts a hit and returns the hits in the current window, including this one. */
    hit: async (key: string) => (await store.increment(key)).totalHits,
    /** The hits in the current window, without counting one (0 once the window has ended). */
    count: async (key: string) => {
      const info = await store.get?.(key);
      return info && (!info.resetTime || info.resetTime.getTime() > Date.now()) ? info.totalHits : 0;
    },
    reset: (key: string) => store.resetKey(key),
  };
}
