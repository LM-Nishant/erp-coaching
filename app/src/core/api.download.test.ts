import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

vi.mock('./token-storage', () => ({
  loadSession: async () => ({ accessToken: 'tok', refreshToken: null, branchId: 7 }),
  saveSession: async () => undefined,
  updateTokens: async () => undefined,
}));

describe('api.download', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the session headers and returns the file with its attachment name', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('a,b\n1,2\n', {
          headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = await api.download('/admin/reports/institutes/export', { format: 'csv', from: undefined });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/admin\/reports\/institutes\/export\?format=csv$/);
    expect(init.headers).toMatchObject({ Accept: '*/*', Authorization: 'Bearer tok', 'X-Branch-Id': '7' });
    expect(file.fileName).toBe('report.csv');
    expect(await file.blob.text()).toBe('a,b\n1,2\n');
  });

  it('returns a null name when the header is not readable and maps API errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('pdf'));
    expect((await api.download('/x')).fileName).toBeNull();

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid range' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(api.download('/x')).rejects.toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'Invalid range',
    });
    await expect(api.download('/x')).rejects.toBeInstanceOf(ApiError);
  });
});
