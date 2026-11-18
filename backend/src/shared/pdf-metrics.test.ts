import { describe, expect, it } from 'vitest';
import { fitHelvetica, helveticaWidth, pdfAscii, wrapHelvetica } from './pdf-metrics';

describe('Helvetica metrics', () => {
  it('measures text with the real Helvetica and Helvetica-Bold widths', () => {
    // H 722 + e 556 + l 222 + l 222 + o 556 = 2278 / 1000 em
    expect(helveticaWidth('Hello', 10)).toBeCloseTo(22.78, 5);
    // T 611 + o 611 + t 333 + a 556 + l 278 = 2389 / 1000 em
    expect(helveticaWidth('Total', 10, true)).toBeCloseTo(23.89, 5);
    // Bold capitals are far wider than the old 0.5 em estimate, which pushed right-aligned
    // headings past their anchor.
    expect(helveticaWidth('TOTAL DUE', 10, true)).toBeCloseTo(57.22, 5);
    expect(helveticaWidth(pdfAscii('₹ 5,000'), 10)).toBe(helveticaWidth('Rs. 5,000', 10));
  });

  it('truncates and wraps to a width in points', () => {
    const fitted = fitHelvetica('Mathematics and Statistics', 60, 9);
    expect(fitted.endsWith('~')).toBe(true);
    expect(helveticaWidth(fitted, 9)).toBeLessThanOrEqual(60);
    expect(fitHelvetica('Maths', 60, 9)).toBe('Maths');
    const lines = wrapHelvetica('alpha beta gamma delta\nepsilon', 60, 10);
    expect(lines.every((l) => helveticaWidth(l, 10) <= 60)).toBe(true);
    expect(lines.join(' ')).toBe('alpha beta gamma delta epsilon');
    expect(lines.at(-1)).toBe('epsilon');
  });
});
