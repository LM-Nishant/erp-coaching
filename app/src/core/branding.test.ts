import { describe, expect, it } from 'vitest';
import { applyBranding } from './branding';

describe('applyBranding', () => {
  const css = (n: string) => document.documentElement.style.getPropertyValue(n);

  it('applies institute colours and picks a readable contrast colour', () => {
    applyBranding({ name: 'Apex', primaryColor: '#ffeb3b', secondaryColor: '#1a237e' });
    expect(css('--ion-color-primary')).toBe('#ffeb3b');
    expect(css('--ion-color-primary-rgb')).toBe('255,235,59');
    expect(css('--ion-color-primary-contrast')).toBe('#000000');
    expect(css('--ion-color-secondary-contrast')).toBe('#ffffff');
    expect(document.title).toBe('Apex · ERP Coaching');
  });

  it('falls back to default theme when no institute is selected', () => {
    applyBranding(null);
    expect(css('--ion-color-primary')).toBe('#3880ff');
    expect(document.title).toBe('ERP Coaching');
  });
});
