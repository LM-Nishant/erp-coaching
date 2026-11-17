import type { LmsFileRef, LmsUploadSessionDto } from '@erp/shared';
import { API_URL, ApiError, api } from '@/core/api';
import { loadSession } from '@/core/token-storage';

const RESUME_KEY = 'lms.upload.';
const fingerprint = (f: File) => `${RESUME_KEY}${f.name}:${f.size}:${f.lastModified}`;

export interface UploadHandle {
  promise: Promise<LmsFileRef>;
  abort: () => void;
}

async function putChunk(uploadId: string, offset: number, blob: Blob, signal: AbortSignal) {
  const session = await loadSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    Accept: 'application/json',
  };
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  if (session?.branchId) headers['X-Branch-Id'] = String(session.branchId);
  return fetch(`${API_URL}/api/lms/uploads/${uploadId}/chunk?offset=${offset}`, {
    method: 'PUT',
    headers,
    body: blob,
    signal,
  });
}

/**
 * Resumable chunked upload for large lecture videos. The upload id is remembered per file so that picking the
 * same file again (after a network drop or app restart) continues from the server's `receivedBytes`.
 */
export function chunkedUpload(
  file: File,
  onProgress: (sent: number, total: number) => void,
  opts: { branchId?: number | null } = {},
): UploadHandle {
  const controller = new AbortController();
  const promise = (async () => {
    let session: LmsUploadSessionDto | null = null;
    const saved = localStorage.getItem(fingerprint(file));
    if (saved) {
      session = await api.get<LmsUploadSessionDto>(`/lms/uploads/${saved}`).catch(() => null);
      if (session?.status !== 'uploading') session = null;
    }
    session ??= await api.post<LmsUploadSessionDto>('/lms/uploads', {
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      totalBytes: file.size,
      branchId: opts.branchId ?? undefined,
    });
    localStorage.setItem(fingerprint(file), session.uploadId);
    let offset = session.receivedBytes;
    let failures = 0;
    onProgress(offset, file.size);
    while (offset < file.size) {
      if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      const end = Math.min(offset + session.chunkBytes, file.size);
      let res: Response;
      try {
        res = await putChunk(session.uploadId, offset, file.slice(offset, end), controller.signal);
      } catch (e) {
        if ((e as Error).name === 'AbortError' || ++failures > 5) throw e;
        await new Promise((r) => setTimeout(r, 1000 * failures));
        continue;
      }
      if (res.ok) {
        offset = ((await res.json()) as LmsUploadSessionDto).receivedBytes;
        failures = 0;
      } else if (res.status === 401 || res.status === 409) {
        // 401: the api helper refreshes the token; 409: realign with the server's offset
        offset = (await api.get<LmsUploadSessionDto>(`/lms/uploads/${session.uploadId}`)).receivedBytes;
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        throw new ApiError(
          res.status,
          body?.error?.code ?? 'UPLOAD_FAILED',
          body?.error?.message ?? res.statusText,
        );
      }
      onProgress(offset, file.size);
    }
    const done = await api.post<LmsUploadSessionDto>(`/lms/uploads/${session.uploadId}/complete`);
    localStorage.removeItem(fingerprint(file));
    return done.file!;
  })();
  return { promise, abort: () => controller.abort() };
}
