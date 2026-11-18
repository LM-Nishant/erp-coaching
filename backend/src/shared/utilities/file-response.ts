import type { Response } from 'express';

/**
 * Uploaded files are served from the API origin with a client-declared type, so the type can't be
 * trusted: an SVG, XHTML or JS upload served as-is would run script on that origin. Only types that
 * browsers render passively keep their type. Text is shown as plain text and anything else is a
 * download of opaque bytes, which `nosniff` stops from being used as a script or stylesheet.
 */
const SANDBOX_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** Never stored: executables and documents that run script when opened in a browser. */
const BLOCKED_UPLOAD =
  /^(text\/html|application\/xhtml\+xml|application\/(x-msdownload|x-msdos-program|x-sh|x-executable|java-archive|vnd\.microsoft\.portable-executable))/;

export function normaliseMimeType(mimeType: string | null | undefined): string {
  return String(mimeType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

export function isBlockedUploadType(mimeType: string | null | undefined): boolean {
  return BLOCKED_UPLOAD.test(normaliseMimeType(mimeType));
}

export interface FileServePolicy {
  contentType: string;
  inline: boolean;
  /** Replace the default CSP with a sandbox (no script) for formats that can be documents. */
  sandbox: boolean;
}

export function fileServePolicy(mimeType: string | null | undefined): FileServePolicy {
  const m = normaliseMimeType(mimeType);
  // Images render passively in <img>; opened directly, an SVG is a document, hence the sandbox.
  if (/^image\/[\w.+-]+$/.test(m)) return { contentType: m, inline: true, sandbox: true };
  // A sandbox would break the built-in PDF viewer; neither PDFs nor media run page script.
  if (/^(video|audio)\/[\w.+-]+$/.test(m) || m === 'application/pdf')
    return { contentType: m, inline: true, sandbox: false };
  if (m.startsWith('text/')) return { contentType: 'text/plain; charset=utf-8', inline: true, sandbox: true };
  return { contentType: 'application/octet-stream', inline: false, sandbox: true };
}

/** RFC 6266 header with an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string | null | undefined) {
  const name =
    String(fileName ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200) || 'download';
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Sets the headers for streaming a stored upload (signed URLs, logos, public website media). */
export function setFileResponseHeaders(
  res: Response,
  file: { mimeType: string; originalName?: string | null },
  cacheControl: string,
): FileServePolicy {
  const policy = fileServePolicy(file.mimeType);
  res.setHeader('Content-Type', policy.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader(
    'Content-Disposition',
    contentDisposition(policy.inline ? 'inline' : 'attachment', file.originalName),
  );
  if (policy.sandbox) res.setHeader('Content-Security-Policy', SANDBOX_CSP);
  return policy;
}
