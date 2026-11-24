import type { AppLocale, MeDto } from '@erp/shared';
import { currentLocale, setLocale } from '@/i18n';
import { api } from './api';

/** A language picked on the sign-in screen, to be saved on the account that signs in next. */
const PENDING_KEY = 'erp.locale.pending';

function takePending(): AppLocale | null {
  try {
    const v = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    return v === 'en' || v === 'hi' ? v : null;
  } catch {
    return null;
  }
}

/** Language picker while signed out: switch now and keep it for the account that signs in. */
export function pickSignedOutLocale(locale: AppLocale) {
  setLocale(locale);
  try {
    localStorage.setItem(PENDING_KEY, locale);
  } catch {
    // Private mode: the choice applies to this session only.
  }
}

/**
 * After `/auth/me`: the app opens in the account's language (English unless the user picked Hindi).
 * A language picked on the sign-in screen just before is saved on the account instead.
 */
export function syncLocaleFromMe(me: MeDto) {
  if (me.impersonatedBy) return;
  const pending = takePending();
  if (pending) {
    if (pending !== me.user.locale) {
      me.user.locale = pending;
      void saveAccountLocale(pending).catch(() => undefined);
    }
    if (pending !== currentLocale()) setLocale(pending);
    return;
  }
  const saved: AppLocale = me.user.locale === 'hi' ? 'hi' : 'en';
  if (saved !== currentLocale()) setLocale(saved);
}

/** Saves the language on the signed-in account. */
export const saveAccountLocale = (locale: AppLocale) =>
  api.put<{ locale: AppLocale }>('/auth/me/locale', { locale });

/** Switches the app language and, when signed in, remembers it on the account. */
export async function chooseLocale(locale: AppLocale, me?: MeDto | null) {
  setLocale(locale);
  if (!me || me.impersonatedBy) return;
  await saveAccountLocale(locale);
  me.user.locale = locale;
}
