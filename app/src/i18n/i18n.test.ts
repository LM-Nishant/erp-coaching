import { afterEach, describe, expect, it } from 'vitest';
import { buildMessages, currentLocale, i18n, namespaceOf, setLocale, type Messages } from '.';

const core = import.meta.glob<{ default: Messages }>('./locales/*.json', { eager: true });
const modules = import.meta.glob<{ default: Messages }>('../modules/*/i18n/*.json', { eager: true });

/** Dotted leaf keys of a message tree. */
const keysOf = (m: Messages, prefix = ''): string[] =>
  Object.entries(m).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : keysOf(v, `${prefix}${k}.`)));

afterEach(() => setLocale('en'));

describe('i18n', () => {
  it('puts module strings under the camel-cased folder name', () => {
    expect(namespaceOf('parent-portal')).toBe('parentPortal');
    const out = buildMessages(
      { './locales/en.json': { default: { common: { ok: 'OK' } } } },
      {
        '../modules/parent-portal/i18n/en.json': { default: { title: 'Child' } },
        '../modules/fees/i18n/hi.json': { default: { title: 'फीस' } },
        '../modules/fees/i18n/fr.json': { default: { title: 'Frais' } },
      },
    );
    expect(out.en).toEqual({ common: { ok: 'OK' }, parentPortal: { title: 'Child' } });
    expect(out.hi).toEqual({ fees: { title: 'फीस' } });
  });

  it('has an English string for every Hindi key, and no Hindi-only file', () => {
    const all = { ...core, ...modules };
    for (const [path, mod] of Object.entries(all)) {
      if (!path.endsWith('/hi.json')) continue;
      const en = all[path.replace(/hi\.json$/, 'en.json')];
      expect(en, `${path} has no en.json`).toBeDefined();
      const missing = keysOf(mod.default).filter((k) => !keysOf(en.default).includes(k));
      expect(missing, `${path}: keys missing in English`).toEqual([]);
    }
  });

  it('switches language and falls back to English for missing Hindi strings', () => {
    const { t } = i18n.global;
    expect(currentLocale()).toBe('en');
    expect(t('common.actions.save')).toBe('Save');
    setLocale('hi');
    expect(document.documentElement.lang).toBe('hi');
    expect(localStorage.getItem('erp.locale')).toBe('hi');
    expect(t('common.actions.save')).toBe('सेव करें');
    i18n.global.mergeLocaleMessage('en', { zz: { onlyEnglish: 'Only English' } });
    expect(t('zz.onlyEnglish')).toBe('Only English');
  });
});
