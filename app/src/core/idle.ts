import { onBeforeUnmount, watch, type WatchSource } from 'vue';

/**
 * Inactivity logout (spec 4.18). The institute sets the timeout (`MeDto.session.idleTimeoutMinutes`);
 * after that long without input the app locks (biometric unlock) or signs out. The API enforces the
 * same timeout on its side (401 `SESSION_IDLE`), so the client timer is a convenience, not the control.
 *
 * - Last activity is kept in localStorage: tabs share it, and it survives the app being suspended.
 * - Screens that are legitimately used without input (a lecture video playing, a live class, an exam
 *   attempt) hold the session with `useSessionHold`.
 * - A heartbeat (`POST /auth/activity`) tells the server about input that made no API call.
 */
export interface IdleMonitorConfig {
  /** 0 = never. Read on every check, so a changed institute setting applies at once. */
  timeoutMinutes: () => number;
  onIdle: () => void;
  heartbeat: () => Promise<unknown>;
}

export const ACTIVITY_KEY = 'erp.lastActivity';
export const IDLE_TICK_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
const WRITE_THROTTLE_MS = 5_000;
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

export class IdleMonitor {
  private config: IdleMonitorConfig = {
    timeoutMinutes: () => 0,
    onIdle: () => undefined,
    heartbeat: async () => undefined,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private holds = 0;
  private lastWrite = 0;
  private lastHeartbeat = 0;
  private readonly onInput = () => this.touch();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = globalThis.localStorage,
  ) {}

  configure(config: IdleMonitorConfig) {
    this.config = config;
  }

  get running() {
    return this.timer !== null;
  }

  /** `fresh`: the user just signed in or unlocked, so the clock restarts. Otherwise earlier inactivity counts. */
  start({ fresh }: { fresh: boolean }) {
    if (fresh || !this.lastActivity()) this.touch(true);
    this.lastHeartbeat = this.now();
    if (this.timer) return;
    for (const e of INPUT_EVENTS)
      globalThis.addEventListener?.(e, this.onInput, { passive: true, capture: true });
    this.timer = setInterval(() => this.tick(), IDLE_TICK_MS);
    this.check();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    for (const e of INPUT_EVENTS) globalThis.removeEventListener?.(e, this.onInput, { capture: true });
  }

  /** Records activity (throttled unless forced). */
  touch(force = false) {
    const t = this.now();
    if (!force && t - this.lastWrite < WRITE_THROTTLE_MS) return;
    this.lastWrite = t;
    this.storage.setItem(ACTIVITY_KEY, String(t));
  }

  lastActivity(): number {
    return Number(this.storage.getItem(ACTIVITY_KEY)) || 0;
  }

  /** Keeps the session alive until the returned function is called. */
  hold(): () => void {
    this.holds++;
    this.touch(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.touch(true);
    };
  }

  tick() {
    if (this.holds > 0) this.touch(true);
    if (this.check()) return;
    const t = this.now();
    if (this.lastActivity() > this.lastHeartbeat && t - this.lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      this.lastHeartbeat = t;
      void this.config.heartbeat().catch(() => undefined);
    }
  }

  /** Locks / signs out when the timeout has passed (also called when the app resumes). Returns true if it did. */
  check(): boolean {
    if (!this.timer) return false;
    const minutes = this.config.timeoutMinutes();
    if (!minutes || this.holds > 0) return false;
    if (this.now() - this.lastActivity() < minutes * 60_000) return false;
    this.stop();
    this.config.onIdle();
    return true;
  }
}

/** The app's monitor; configured and started by core/session.ts. */
export const idleMonitor = new IdleMonitor();

/** Keeps the session from timing out while `active` is true (e.g. a lecture video playing). */
export function useSessionHold(active: WatchSource<boolean>) {
  let release: (() => void) | null = null;
  const stop = watch(
    active,
    (on) => {
      if (on && !release) release = idleMonitor.hold();
      else if (!on && release) {
        release();
        release = null;
      }
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    stop();
    release?.();
    release = null;
  });
}
