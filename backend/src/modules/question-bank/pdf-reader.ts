/**
 * Reads question-paper PDFs on the server: the text layer (as ordered lines), where embedded images
 * (diagrams) sit on each page, page renders for the vision model and diagram crops.
 *
 * Uses pdf.js (pure JS) and @napi-rs/canvas (prebuilt binaries) for rendering.
 */
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AppError } from '../../shared/errors';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs> | null = null;
const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));

/** Normalised box on the page: [left, top, right, bottom], each 0–1 from the top-left corner. */
export type Box = [number, number, number, number];

export interface PageFigure {
  /** Marker used in the page text, e.g. `F1`. */
  id: string;
  box: Box;
}

export interface PdfPageContent {
  number: number;
  /** Text lines top to bottom, with `[FIGURE Fn]` markers where embedded images sit. */
  text: string;
  /** Printable characters in the text layer (excluding markers). */
  charCount: number;
  figures: PageFigure[];
  /** One image covers most of the page with little or no text: a scan or photo. */
  scanned: boolean;
  /** Many vector drawing operations: likely drawn diagrams, graphs or circuit figures. */
  vectorDrawing: boolean;
  /** Characters outside basic Latin that commonly appear in equations. */
  mathSymbols: number;
}

export interface OpenedPdf {
  numPages: number;
  page(n: number): Promise<PdfPageContent>;
  /** JPEG render of the page with the longer side about `maxSide` pixels. */
  renderJpeg(n: number, maxSide?: number): Promise<Buffer>;
  /** PNG crop of a normalised box on the page (with a small margin). */
  crop(n: number, box: Box, maxSide?: number): Promise<Buffer>;
  close(): Promise<void>;
}

const MATH_CHARS =
  /[\u00b2\u00b3\u00b9\u00b1\u00d7\u00f7\u0370-\u03ff\u2070-\u209f\u2200-\u22ff\u221a\u222b\u2264\u2265]/gu;

/** Opens a PDF, rejecting files that are not PDFs, are encrypted or are damaged. */
export async function openPdf(data: Buffer): Promise<OpenedPdf> {
  if (data.subarray(0, 1024).indexOf('%PDF-') < 0)
    throw new AppError(400, 'NOT_A_PDF', 'The file is not a PDF');
  const pdfjs = await loadPdfJs();
  let doc: PDFDocumentProxy;
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`,
    cMapUrl: `${PDFJS_DIR}/cmaps/`,
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const name = (err as { name?: string }).name;
    if (name === 'PasswordException')
      throw new AppError(
        400,
        'PDF_ENCRYPTED',
        'The PDF is password-protected. Remove the password and upload it again',
      );
    throw new AppError(400, 'PDF_UNREADABLE', 'The PDF could not be read. It may be damaged');
  }

  const pages = new Map<number, PDFPageProxy>();
  const getPage = async (n: number) => {
    let p = pages.get(n);
    if (!p) {
      p = await doc.getPage(n);
      pages.set(n, p);
    }
    return p;
  };

  async function render(n: number, maxSide: number) {
    const page = await getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxSide / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // @napi-rs/canvas implements the subset of the DOM canvas API pdf.js uses.
    const params = { canvas, canvasContext: ctx, viewport } as unknown as Parameters<
      PDFPageProxy['render']
    >[0];
    await page.render(params).promise;
    return canvas;
  }

  return {
    numPages: doc.numPages,
    page: async (n) => readPage(pdfjs, await getPage(n), n),
    renderJpeg: async (n, maxSide = 1600) => (await render(n, maxSide)).toBuffer('image/jpeg', 85),
    async crop(n, box, maxSide = 2000) {
      const canvas = await render(n, maxSide);
      const m = 0.01;
      const x0 = Math.max(0, Math.floor((box[0] - m) * canvas.width));
      const y0 = Math.max(0, Math.floor((box[1] - m) * canvas.height));
      const x1 = Math.min(canvas.width, Math.ceil((box[2] + m) * canvas.width));
      const y1 = Math.min(canvas.height, Math.ceil((box[3] + m) * canvas.height));
      const out = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      const img = await loadImage(canvas.toBuffer('image/png'));
      out.getContext('2d').drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
      return out.toBuffer('image/png');
    },
    async close() {
      await task.destroy();
    },
  };
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

async function readPage(pdfjs: PdfJs, page: PDFPageProxy, number: number): Promise<PdfPageContent> {
  const viewport = page.getViewport({ scale: 1 });
  const W = viewport.width;
  const H = viewport.height;
  const t = viewport.transform as Matrix;
  const toViewport = (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  const toBox = (x0: number, y0: number, x1: number, y1: number): Box => {
    const [a, b] = toViewport(x0, y0);
    const [c, d] = toViewport(x1, y1);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
      clamp(Math.min(a, c) / W),
      clamp(Math.min(b, d) / H),
      clamp(Math.max(a, c) / W),
      clamp(Math.max(b, d) / H),
    ];
  };

  // ---- text lines
  const content = await page.getTextContent();
  type Item = { str: string; x: number; y: number; w: number; h: number };
  const items: Item[] = [];
  for (const it of content.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const [, , , , x, y] = it.transform as number[];
    const top = toViewport(x, y)[1] / H;
    items.push({ str: it.str, x, y: top, w: it.width, h: Math.abs(it.transform[3] as number) || 10 });
  }
  items.sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: { y: number; parts: Item[] }[] = [];
  for (const it of items) {
    const tol = (it.h / H) * 0.5;
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.parts.push(it);
    else lines.push({ y: it.y, parts: [it] });
  }
  const textLines = lines
    .sort((a, b) => a.y - b.y)
    .map((l) => {
      const parts = l.parts.sort((a, b) => a.x - b.x);
      let s = '';
      let end = -Infinity;
      for (const p of parts) {
        if (s && p.x - end > p.h * 0.2 && !s.endsWith(' ') && !p.str.startsWith(' ')) s += ' ';
        s += p.str;
        end = p.x + p.w;
      }
      return { y: l.y, text: s.replace(/\s+/g, ' ').trim() };
    })
    .filter((l) => l.text);

  // ---- images and drawing operations
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const imageOps = new Set<number>([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
  ]);
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const images: Box[] = [];
  let drawOps = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as Matrix | null;
      if (Array.isArray(m) && m.length === 6) ctm = multiply(ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) drawOps++;
    else if (imageOps.has(fn)) {
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      images.push(toBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
    }
  }
  const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
  const charCount = textLines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
  const pageImage = images.find((b) => area(b) > 0.6);
  const scanned = !!pageImage && charCount < 200;
  const figureBoxes = images.filter((b) => area(b) >= 0.004 && area(b) <= 0.6);
  const figures: PageFigure[] = figureBoxes
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map((box, i) => ({ id: `F${i + 1}`, box }));

  // Interleave figure markers with the text by vertical position.
  const merged = [
    ...textLines.map((l) => ({ y: l.y, text: l.text })),
    ...figures.map((f) => ({ y: f.box[1] + 1e-6, text: `[FIGURE ${f.id}]` })),
  ].sort((a, b) => a.y - b.y);
  const text = merged.map((l) => l.text).join('\n');

  return {
    number,
    text,
    charCount,
    figures,
    scanned: scanned || (charCount < 20 && images.length > 0),
    vectorDrawing: drawOps > 40,
    mathSymbols: (text.match(MATH_CHARS) ?? []).length,
  };
}
