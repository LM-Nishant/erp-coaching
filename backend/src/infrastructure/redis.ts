import { createClient } from 'redis';
import { config } from './config';
import { logger } from './logger';

export type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
const extra: RedisClient[] = [];

function open(c: RedisClient, name: string): RedisClient {
  c.on('error', (err) => logger.error({ err, connection: name }, 'Redis connection error'));
  // The client reconnects on its own after a lost connection.
  c.connect().catch((err) => logger.error({ err, connection: name }, 'Redis connect failed'));
  return c;
}

/**
 * The shared Redis connection when REDIS_URL is set, else null. Without Redis, rate-limit counters and
 * live-class sockets stay in this process, which is only correct for a single API instance.
 *
 * Commands fail fast instead of queueing while Redis is unreachable (callers fall back to memory).
 */
export function getRedis(): RedisClient | null {
  if (!config.REDIS_URL) return null;
  client ??= open(
    createClient({ url: config.REDIS_URL, disableOfflineQueue: true, commandOptions: { timeout: 1000 } }),
    'main',
  );
  return client;
}

/**
 * A dedicated connection (Socket.IO publish / subscribe), closed with the main one. Commands queue while
 * it reconnects, up to a bound.
 */
export function newRedisConnection(name: string): RedisClient | null {
  if (!config.REDIS_URL) return null;
  const c = open(createClient({ url: config.REDIS_URL, commandsQueueMaxLength: 10_000 }), name);
  extra.push(c);
  return c;
}

export async function closeRedis(): Promise<void> {
  const all = [...extra.splice(0), ...(client ? [client] : [])];
  client = null;
  await Promise.all(all.map((c) => (c.isOpen ? c.close().catch(() => undefined) : undefined)));
}
