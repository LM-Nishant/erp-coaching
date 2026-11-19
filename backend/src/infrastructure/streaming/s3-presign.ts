import crypto from 'node:crypto';

/** RFC 3986 encoding used by AWS Signature V4. */
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

export interface S3Location {
  bucket: string;
  region: string;
  /** Custom endpoint of an S3-compatible store (`https://<account>.r2.cloudflarestorage.com`); blank = AWS. */
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKey: string;
  secretKey: string;
}

/**
 * Presigned S3 URL (AWS Signature V4, query string auth, `UNSIGNED-PAYLOAD`) for one object, or for
 * the bucket when `key` is empty. Works with AWS and S3-compatible stores.
 */
export function presignS3Url(
  loc: S3Location,
  input: {
    method: 'GET' | 'HEAD' | 'DELETE';
    key: string;
    expiresInSeconds: number;
    query?: Record<string, string>;
    now?: Date;
  },
): string {
  const endpoint = new URL(loc.endpoint || `https://s3.${loc.region}.amazonaws.com`);
  const keyPath = input.key
    .split('/')
    .filter((p, i) => p || i > 0)
    .map(enc)
    .join('/');
  const host = loc.forcePathStyle ? endpoint.host : `${loc.bucket}.${endpoint.host}`;
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const pathname = loc.forcePathStyle
    ? `${basePath}/${enc(loc.bucket)}/${keyPath}`
    : `${basePath}/${keyPath}`;

  const amzDate = (input.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${loc.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${loc.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const canonical = [input.method, pathname, query, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join(
    '\n',
  );
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${loc.secretKey}`, day), loc.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `${endpoint.protocol}//${host}${pathname}?${query}&X-Amz-Signature=${signature}`;
}
