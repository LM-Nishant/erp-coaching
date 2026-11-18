import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, IdleMonitor } from './idle';

const MIN = 60_000;
const monitors: IdleMonitor[] = [];

function setup(timeoutMinutes: number) {
  const clock = { now: 1_000_000_000 };
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const setting = { minutes: timeoutMinutes };
  const onIdle = vi.fn();
  const heartbeat = vi.fn(async () => undefined);
  const make = () => {
    const m = new IdleMonitor(() => clock.now, storage);
    m.configure({ timeoutMinutes: () => setting.minutes, onIdle, heartbeat });
    monitors.push(m);
    return m;
  };
  return { monitor: make(), make, setting, onIdle, heartbeat, advance: (ms: number) => (clock.now += ms) };
}

const input = () => globalThis.dispatchEvent(new Event('pointerdown'));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  monitors.splice(0).forEach((m) => m.stop());
  vi.useRealTimers();
});

describe('IdleMonitor (inactivity logout)', () => {
  it('ends the session after the institute timeout without input; input restarts the clock', () => {
    const { monitor, onIdle, advance } = setup(10);
    monitor.start({ fresh: true });
    advance(9 * MIN);
    input();
    advance(9 * MIN);
    monitor.tick();
    expect(onIdle).not.toHaveBeenCalled();

    advance(MIN);
    monitor.tick();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(monitor.running).toBe(false);
  });

  it('never times out when the setting is 0, and a changed setting applies at once', () => {
    const { monitor, setting, onIdle, advance } = setup(0);
    monitor.start({ fresh: true });
    advance(24 * 60 * MIN);
    monitor.tick();
    expect(onIdle).not.toHaveBeenCalled();

    setting.minutes = 15;
    monitor.tick();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('locks as soon as the app resumes or restarts after the timeout', () => {
    const { monitor, make, onIdle, advance } = setup(10);
    monitor.start({ fresh: true });
    // Suspended in the background: no timers run.
    advance(11 * MIN);
    expect(monitor.check()).toBe(true);
    expect(onIdle).toHaveBeenCalledOnce();

    // Killed and relaunched: the last activity is read back from storage.
    make().start({ fresh: false });
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it('holds keep the session alive (video, live class, exam) and the clock restarts on release', () => {
    const { monitor, onIdle, advance } = setup(10);
    monitor.start({ fresh: true });
    const release = monitor.hold();
    for (let i = 0; i < 6; i++) {
      advance(15 * MIN);
      monitor.tick();
    }
    expect(onIdle).not.toHaveBeenCalled();

    release();
    release(); // idempotent: an unmount after the watcher already released
    const again = monitor.hold();
    advance(30 * MIN);
    monitor.tick();
    expect(onIdle).not.toHaveBeenCalled();

    again();
    advance(9 * MIN);
    monitor.tick();
    expect(onIdle).not.toHaveBeenCalled();
    advance(MIN);
    monitor.tick();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('reports input to the server at most once a minute, and only when there was input', () => {
    const { monitor, heartbeat, advance } = setup(30);
    monitor.start({ fresh: true });
    advance(2 * MIN);
    monitor.tick();
    expect(heartbeat).not.toHaveBeenCalled();

    input();
    advance(15_000);
    monitor.tick();
    expect(heartbeat).toHaveBeenCalledOnce();

    advance(5_000);
    input();
    advance(15_000);
    monitor.tick();
    expect(heartbeat).toHaveBeenCalledOnce();

    advance(HEARTBEAT_INTERVAL_MS);
    monitor.tick();
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });
});
