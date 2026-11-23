import { createI18n } from 'vue-i18n';

/**
 * App languages. Strings live in JSON per language:
 * - `src/i18n/locales/{en,hi}.json`: shared words, under `common.*` (e.g. `common.actions.save`).
 * - `src/modules/<folder>/i18n/{en,hi}.json`: a module's strings, under the camel-cased folder name
 *   (`parent-portal` → `parentPortal.*`), so modules never edit a shared file.
 * English is complete; a key missing in Hindi falls back to English.
 */
export const LOCALES = ['en', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];
/** Name of each language in itself, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', hi: 'हिंदी' };

const STORAGE_KEY = 'erp.locale';
const INTL_LOCALES: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN' };

export type Messages = { [key: string]: string | Messages };
type JsonModules = Record<string, { default: Messages }>;

/** `parent-portal` → `parentPortal`. */
export const namespaceOf = (folder: string) =>
  folder.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Merges the core and module JSON files (glob results keyed by path) into one tree per locale. */
export function buildMessages(core: JsonModules, modules: JsonModules): Record<Locale, Messages> {
  const out = Object.fromEntries(LOCALES.map((l) => [l, {} as Messages])) as Record<Locale, Messages>;
  for (const [path, mod] of Object.entries(core)) {
    const locale = /\/(\w+)\.json$/.exec(path)?.[1] as Locale | undefined;
    if (locale && locale in out) Object.assign(out[locale], mod.default);
  }
  for (const [path, mod] of Object.entries(modules)) {
    const m = /modules\/([^/]+)\/i18n\/(\w+)\.json$/.exec(path);
    if (!m || !(m[2] in out)) continue;
    out[m[2] as Locale][namespaceOf(m[1])] = mod.default;
  }
  return out;
}

const messages = buildMessages(
  import.meta.glob<{ default: Messages }>('./locales/*.json', { eager: true }),
  import.meta.glob<{ default: Messages }>('../modules/*/i18n/*.json', { eager: true }),
);

function storedLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (LOCALES as readonly string[]).includes(v ?? '') ? (v as Locale) : 'en';
  } catch {
    return 'en';
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: storedLocale(),
  fallbackLocale: 'en',
  messages,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
});

export const currentLocale = (): Locale => i18n.global.locale.value as Locale;
/** BCP 47 tag for `Intl` (`en-IN` / `hi-IN`); see core/format.ts. */
export const intlLocale = () => INTL_LOCALES[currentLocale()];

/** Switches the language for the whole app and remembers it on this device. */
export function setLocale(locale: Locale) {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Private mode: the choice lasts for this session only.
  }
}
