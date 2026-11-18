import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: 'android',
  captured: false,
  listeners: {} as Record<string, () => void>,
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
  post: vi.fn(async () => undefined),
  toast: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => h.platform !== 'web', getPlatform: () => h.platform },
  registerPlugin: () => ({ isCaptured: async () => ({ captured: h.captured }) }),
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock('@capacitor-community/privacy-screen', () => ({
  PrivacyScreen: {
    enable: h.enable,
    disable: h.disable,
    addListener: vi.fn(async (event: string, cb: () => void) => {
      h.listeners[event] = cb;
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock('./api', () => ({ api: { post: h.post } }));
vi.mock('./toast', () => ({ toast: h.toast }));

const { captureActive, initSecureScreen, protectScreen, protectedScreens } = await import('./secure-screen');
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('secure screens', () => {
  it('keeps FLAG_SECURE on until the last protected screen closes; ordinary screens are unaffected', async () => {
    h.platform = 'android';
    const lecture = protectScreen('lms-content');
    const exam = protectScreen('exam-attempt');
    await settle();
    expect(h.enable).toHaveBeenCalledOnce();

    lecture();
    lecture();
    await settle();
    expect(h.disable).not.toHaveBeenCalled();
    expect(protectedScreens()).toEqual(['exam-attempt']);

    exam();
    await settle();
    expect(h.disable).toHaveBeenCalledOnce();
    expect(protectedScreens()).toEqual([]);
  });

  it('iOS: audits screenshots and recordings of protected screens only, and hides content while recording', async () => {
    h.platform = 'ios';
    initSecureScreen();
    await settle();
    h.listeners.screenshotTaken();
    expect(h.post).not.toHaveBeenCalled();

    const release = protectScreen('question-paper');
    await settle();
    h.listeners.screenshotTaken();
    expect(h.post).toHaveBeenCalledWith(
      '/auth/capture-events',
      { kind: 'screenshot', screens: ['question-paper'] },
      { background: true },
    );
    expect(h.toast).toHaveBeenCalledOnce();

    h.listeners.screenRecordingStarted();
    await settle();
    expect(captureActive.value).toBe(true);
    expect(h.post).toHaveBeenLastCalledWith(
      '/auth/capture-events',
      { kind: 'recording', screens: ['question-paper'] },
      { background: true },
    );

    h.listeners.screenRecordingStopped();
    release();
    await settle();
    expect(captureActive.value).toBe(false);
  });
});
