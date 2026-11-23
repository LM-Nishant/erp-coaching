import { APP_LOCALES, type AppLocale, type MeDto } from '@erp/shared';
import { currentLocale, setLocale } from '@/i18n';
import { api } from './api';

const isLocale = (v: unknown): v is AppLocale => (APP_LOCALES as readonly unknown[]).includes(v);

/** Whether the user picked a language on this device (not just the English default). */
function devicePicked(): boolean {
  try {
    return isLocale(localStorage.getItem('erp.locale'));
  } catch {
    return false;
  }
}

/**
 * After `/auth/me`: open in the language saved on the account. An account without one adopts the
 * language picked on this device, so it follows the user to their other devices.
 */
export function syncLocaleFromMe(me: MeDto) {
  if (me.impersonatedBy) return;
  const saved = me.user.locale;
  if (isLocale(saved)) {
    if (saved !== currentLocale()) setLocale(saved);
  } else if (devicePicked()) {
    void saveAccountLocale(currentLocale()).catch(() => undefined);
  }
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
