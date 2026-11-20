import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ platform: 'web' }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => h.platform !== 'web', getPlatform: () => h.platform },
}));
vi.mock('@/core/api', () => ({ api: {} }));

const { connectResultMessage, openConsent, syncLabel } = await import('./api');

afterEach(() => {
  vi.restoreAllMocks();
  h.platform = 'web';
});

describe('Google Calendar connect', () => {
  it.each(['web', 'ios', 'android'])(
    'opens the consent link by navigating, which still works after the awaited request (%s)',
    (platform) => {
      h.platform = platform;
      const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
      const open = vi.spyOn(window, 'open');
      const startUrl = 'https://api.example.com/api/calendar/public/google/start?state=abc';
      openConsent({ startUrl, expiresAt: new Date().toISOString() });
      expect(assign).toHaveBeenCalledWith(startUrl);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('only shows a message for results the consent flow returns', () => {
    expect(connectResultMessage('connected')).toEqual(['Google Calendar connected', 'success']);
    expect(connectResultMessage('missing_scope')?.[1]).toBe('warning');
    expect(connectResultMessage('<b>hi</b>')).toBeNull();
    expect(connectResultMessage(['connected'])).toBeNull();
  });

  it('labels where a meeting stands in Google Calendar, and nothing for the mock calendar', () => {
    const at = { error: null, syncedAt: null };
    expect(syncLabel({ ...at, provider: 'mock', status: 'synced' })).toBeNull();
    expect(syncLabel(null)).toBeNull();
    expect(syncLabel({ ...at, provider: 'google', status: 'pending', error: 'Backend Error' })).toEqual({
      title: 'Updating Google Calendar…',
      detail: 'Retrying: Backend Error',
    });
    expect(
      syncLabel({ ...at, provider: 'google', status: 'failed', error: 'No Google Calendar is connected' }),
    ).toEqual({ title: 'Not in Google Calendar', detail: 'No Google Calendar is connected' });
  });
});
