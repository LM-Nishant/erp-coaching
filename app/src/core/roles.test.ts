import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { roleName, roleNames } from './roles';

const t = (locale: 'en' | 'hi') => (key: string) => i18n.global.t(key, {}, { locale });

describe('roleName', () => {
  it('translates system roles and reads custom role slugs as words', () => {
    expect(roleName('institute-admin', t('en'))).toBe('Institute admin');
    expect(roleName('student', t('hi'))).toBe('छात्र');
    expect(roleName('custom-front-desk', t('en'))).toBe('Front desk');
  });

  it('joins every role once', () => {
    expect(roleNames(['teacher', 'parent', 'teacher'], t('en'))).toBe('Teacher, Parent');
    expect(roleNames(undefined, t('en'))).toBe('');
  });
});
