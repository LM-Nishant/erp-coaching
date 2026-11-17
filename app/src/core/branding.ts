import type { InstituteBranding } from '@erp/shared';

const DEFAULT = { primary: '#3880ff', secondary: '#5260ff' };

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}

function shade(hex: string, factor: number) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) =>
    Math.round(factor < 0 ? c * (1 + factor) : c + (255 - c) * factor)
      .toString(16)
      .padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

function contrast(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000000' : '#ffffff';
}

function setColor(name: 'primary' | 'secondary', hex: string) {
  const s = document.documentElement.style;
  const [r, g, b] = hexToRgb(hex);
  const c = contrast(hex);
  s.setProperty(`--ion-color-${name}`, hex);
  s.setProperty(`--ion-color-${name}-rgb`, `${r},${g},${b}`);
  s.setProperty(`--ion-color-${name}-contrast`, c);
  s.setProperty(`--ion-color-${name}-contrast-rgb`, c === '#ffffff' ? '255,255,255' : '0,0,0');
  s.setProperty(`--ion-color-${name}-shade`, shade(hex, -0.12));
  s.setProperty(`--ion-color-${name}-tint`, shade(hex, 0.1));
}

/** Applies the institute's colours to Ionic's theme variables at runtime (white-label branding). */
export function applyBranding(b: Pick<InstituteBranding, 'primaryColor' | 'secondaryColor' | 'name'> | null) {
  setColor('primary', b?.primaryColor ?? DEFAULT.primary);
  setColor('secondary', b?.secondaryColor ?? DEFAULT.secondary);
  document.title = b?.name ? `${b.name} · ERP Coaching` : 'ERP Coaching';
}
