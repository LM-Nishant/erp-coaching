import { beforeEach, describe, expect, it, vi } from 'vitest';
import { breakdownPercents, relativeDate, starParts } from './engagement-api';

const auth = { isAuthenticated: true, offline: false };
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));

const api = vi.hoisted(() => ({
  wishlistIds: vi.fn(),
  addToWishlist: vi.fn(),
  removeFromWishlist: vi.fn(),
}));
vi.mock('./engagement-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./engagement-api')>()),
  engagementApi: api,
}));

describe('rating helpers', () => {
  it('turns the star breakdown into percentages, five stars first', () => {
    expect(breakdownPercents([1, 0, 0, 1, 2])).toEqual([
      { stars: 5, count: 2, percent: 50 },
      { stars: 4, count: 1, percent: 25 },
      { stars: 3, count: 0, percent: 0 },
      { stars: 2, count: 0, percent: 0 },
      { stars: 1, count: 1, percent: 25 },
    ]);
    expect(breakdownPercents([0, 0, 0, 0, 0]).every((r) => r.percent === 0)).toBe(true);
  });

  it('rounds ratings to half stars', () => {
    expect(starParts(4.5)).toEqual({ full: 4, half: true, empty: 0 });
    expect(starParts(4.26)).toEqual({ full: 4, half: true, empty: 0 });
    expect(starParts(4.2)).toEqual({ full: 4, half: false, empty: 1 });
    expect(starParts(0)).toEqual({ full: 0, half: false, empty: 5 });
    expect(starParts(9)).toEqual({ full: 5, half: false, empty: 0 });
  });

  it('describes dates relative to now', () => {
    const now = Date.parse('2026-06-30T12:00:00Z');
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    expect(relativeDate(ago(0), now)).toBe('today');
    expect(relativeDate(ago(1), now)).toBe('yesterday');
    expect(relativeDate(ago(10), now)).toBe('10 days ago');
    expect(relativeDate(ago(40), now)).toBe('a month ago');
    expect(relativeDate(ago(100), now)).toBe('3 months ago');
    expect(relativeDate(ago(400), now)).toBe('a year ago');
    expect(relativeDate(ago(800), now)).toBe('2 years ago');
  });
});

describe('useWishlist', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(api).forEach((fn) => fn.mockReset());
    auth.isAuthenticated = true;
  });

  it('loads saved ids once and toggles courses', async () => {
    const { useWishlist } = await import('./wishlist-store');
    api.wishlistIds.mockResolvedValue({ courseIds: [3] });
    api.addToWishlist.mockResolvedValue({ courseIds: [3, 7] });
    api.removeFromWishlist.mockResolvedValue({ courseIds: [7] });

    const wishlist = useWishlist();
    await Promise.all([wishlist.load(), useWishlist().load()]);
    expect(api.wishlistIds).toHaveBeenCalledTimes(1);
    expect(wishlist.has(3)).toBe(true);

    expect(await wishlist.toggle(7)).toBe(true);
    expect(api.addToWishlist).toHaveBeenCalledWith(7);
    expect(await wishlist.toggle(3)).toBe(false);
    expect(api.removeFromWishlist).toHaveBeenCalledWith(3);
    expect(useWishlist().has(7)).toBe(true);

    wishlist.forget(7);
    expect(wishlist.has(7)).toBe(false);
  });

  it('is empty when signed out', async () => {
    const { useWishlist } = await import('./wishlist-store');
    auth.isAuthenticated = false;
    await useWishlist().load();
    expect(api.wishlistIds).not.toHaveBeenCalled();
    expect(useWishlist().ids.value.size).toBe(0);
  });
});
