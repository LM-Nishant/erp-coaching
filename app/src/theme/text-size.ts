/**
 * Text size setting (accessibility): scales the root font size, which Ionic's typography and our `rem`
 * sizes follow. Remembered on the device.
 */
export const TEXT_SIZES = [100, 115, 130] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

const STORAGE_KEY = 'erp.textSize';

export function storedTextSize(): TextSize {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return (TEXT_SIZES as readonly number[]).includes(v) ? (v as TextSize) : 100;
  } catch {
    return 100;
  }
}

export function applyTextSize(size: TextSize, remember = true) {
  document.documentElement.style.fontSize = size === 100 ? '' : `${size}%`;
  if (!remember) return;
  try {
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // Private mode: lasts for this session only.
  }
}
