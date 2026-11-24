import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeDto } from '@erp/shared';
import { api } from '@/core/api';
import { currentLocale, setLocale } from '@/i18n';
import { chooseLocale, pickSignedOutLocale, syncLocaleFromMe } from '@/core/locale-sync';
import { clock, doubtsApi } from './api';

const me = (locale: 'en' | 'hi', extra: Partial<MeDto> = {}) =>
  ({ user: { id: 1, locale }, ...extra }) as unknown as MeDto;

describe('doubts api', () => {
  afterEach(() => vi.restoreAllMocks());

  it('formats the lecture position', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65.7)).toBe('1:05');
    expect(clock(3725)).toBe('1:02:05');
  });

  it('sends the question, links and photo as a form, leaving out empty fields', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({});
    const photo = new File(['x'], 'board.png', { type: 'image/png' });
    await doubtsApi.ask({ question: 'Why?', lectureId: 7, positionSeconds: 90, subjectId: null, photo });
    const [path, form] = post.mock.calls[0] as [string, FormData];
    expect(path).toBe('/doubts');
    expect(form.get('question')).toBe('Why?');
    expect(form.get('lectureId')).toBe('7');
    expect(form.get('positionSeconds')).toBe('90');
    expect(form.has('subjectId')).toBe(false);
    expect((form.get('file') as File).name).toBe('board.png');
  });
});

describe('account language', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLocale('en');
    localStorage.clear();
  });

  it('opens in the language saved on the account', () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    syncLocaleFromMe(me('hi'));
    expect(currentLocale()).toBe('hi');
    expect(put).not.toHaveBeenCalled();
  });

  it('a fresh device opens in English, even when the browser prefers Hindi', async () => {
    localStorage.clear();
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('hi-IN');
    vi.resetModules();
    const fresh = await import('@/i18n');
    expect(fresh.currentLocale()).toBe('en');
  });

  it('a fresh account (English) wins over a stale Hindi choice on this device', () => {
    setLocale('hi');
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    syncLocaleFromMe(me('en'));
    expect(currentLocale()).toBe('en');
    expect(put).not.toHaveBeenCalled();
  });

  it('saves a language picked on the sign-in screen to the account that signs in', () => {
    pickSignedOutLocale('hi');
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    const profile = me('en');
    syncLocaleFromMe(profile);
    expect(currentLocale()).toBe('hi');
    expect(put).toHaveBeenCalledWith('/auth/me/locale', { locale: 'hi' });
    expect(profile.user.locale).toBe('hi');
    put.mockClear();
    syncLocaleFromMe(profile);
    expect(put).not.toHaveBeenCalled();
  });

  it('leaves the account alone while impersonating', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    syncLocaleFromMe(me('hi', { impersonatedBy: { id: 9 } } as Partial<MeDto>));
    expect(currentLocale()).toBe('en');
    await chooseLocale('hi', me('en', { impersonatedBy: { id: 9 } } as Partial<MeDto>));
    expect(currentLocale()).toBe('hi');
    expect(put).not.toHaveBeenCalled();
  });

  it('switching remembers the choice on the account', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    const profile = me('en');
    await chooseLocale('hi', profile);
    expect(put).toHaveBeenCalledWith('/auth/me/locale', { locale: 'hi' });
    expect(profile.user.locale).toBe('hi');
  });
});
