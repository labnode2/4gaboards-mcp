import { describe, expect, it, vi } from 'vitest';
import { FourgaClient } from '../src/api/client.js';
import { ApiError } from '../src/api/errors.js';
import { loadConfig, type Credentials } from '../src/config.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function make(handler: Handler, credentials: Credentials, allowDelete = false) {
  const fetchFn = vi.fn(async (input: URL | string | Request, init?: RequestInit) =>
    handler(new URL(input.toString()), init ?? {}),
  );
  const client = new FourgaClient(
    { baseUrl: 'http://x.test', credentials, allowDelete, timeoutMs: 5000 },
    { fetchFn: fetchFn as unknown as typeof fetch, retryDelayMs: 1 },
  );
  return { client, fetchFn };
}
const pw: Credentials = { kind: 'password', username: 'bot', password: 'secret' };
const apiClient: Credentials = { kind: 'apiClient', clientId: 'cid', clientSecret: 'csec' };
const hdr = (init: RequestInit, k: string) => (init.headers as Record<string, string>)[k];

describe('auth', () => {
  it('logs in once, reuses the bearer token', async () => {
    const { client, fetchFn } = make((url) => {
      if (url.pathname === '/api/access-tokens') return json(200, { item: 'jwt1' });
      return json(200, { items: [], included: { boards: [] } });
    }, pw);
    await client.listProjects();
    await client.listProjects();
    const logins = fetchFn.mock.calls.filter(([u]) => String(u).endsWith('/access-tokens'));
    expect(logins).toHaveLength(1);
    expect(hdr(fetchFn.mock.calls[1]![1]!, 'Authorization')).toBe('Bearer jwt1');
  });

  it('shares one login between concurrent requests', async () => {
    const { client, fetchFn } = make((url) =>
      url.pathname === '/api/access-tokens' ? json(200, { item: 'j' }) : json(200, { items: [] }),
    pw);
    await Promise.all([client.listProjects(), client.listProjects(), client.listProjects()]);
    expect(fetchFn.mock.calls.filter(([u]) => String(u).endsWith('/access-tokens'))).toHaveLength(1);
  });

  it('re-logs in on 401 and replays the request (also for writes)', async () => {
    let n = 0;
    const { client, fetchFn } = make((url, init) => {
      if (url.pathname === '/api/access-tokens') return json(200, { item: `jwt${++n}` });
      return hdr(init, 'Authorization') === 'Bearer jwt1'
        ? json(401, { code: 'E_UNAUTHORIZED', message: 'Access token is missing, invalid or expired' })
        : json(200, { item: { id: '5', text: 'x' } });
    }, pw);
    await client.createComment('1', 'hi');
    expect(n).toBe(2);
    expect(fetchFn.mock.calls.filter(([, i]) => i?.method === 'POST' && String((i as RequestInit).body).includes('hi'))).toHaveLength(2);
  });

  it('does not loop on repeated 401', async () => {
    const { client, fetchFn } = make((url) =>
      url.pathname === '/api/access-tokens' ? json(200, { item: 'j' }) : json(401, { message: 'nope' }), pw);
    await expect(client.listProjects()).rejects.toThrow(/check credentials/);
    expect(fetchFn.mock.calls.length).toBe(4); // login, request, re-login, request - then stop
  });

  it('reports failed login without leaking the password', async () => {
    const { client } = make(() => json(401, { code: 'E_UNAUTHORIZED', message: 'Invalid username or password' }), pw);
    const err = await client.listProjects().catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/Login failed/);
    expect((err as ApiError).message).not.toContain('secret');
  });

  it('sends API client headers and never logs in', async () => {
    const { client, fetchFn } = make(() => json(200, { items: [] }), apiClient);
    await client.listProjects();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0]![1]!;
    expect(hdr(init, 'X-Client-Id')).toBe('cid');
    expect(hdr(init, 'X-Client-Secret')).toBe('csec');
    expect(hdr(init, 'Authorization')).toBeUndefined();
  });

  it('uses a static token as bearer and cannot refresh', async () => {
    const { client, fetchFn } = make(() => json(401, { message: 'expired' }), { kind: 'token', token: 'T' });
    await expect(client.listProjects()).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(hdr(fetchFn.mock.calls[0]![1]!, 'Authorization')).toBe('Bearer T');
  });
});

describe('requests and errors', () => {
  it('maps the board snapshot and sorts lists', async () => {
    const { client } = make(() =>
      json(200, {
        item: { id: '1', projectId: '9', name: 'B', position: 1 },
        included: {
          lists: [{ id: '3', position: 2, name: 'b' }, { id: '2', position: 1, name: 'a' }],
          cards: [{ id: '10' }],
        },
      }), apiClient);
    const b = await client.getBoard('1');
    expect(b.lists.map((l) => l.id)).toEqual(['2', '3']);
    expect(b.cards).toHaveLength(1);
    expect(b.tasks).toEqual([]);
  });

  it('sends JSON bodies to the right endpoints', async () => {
    const { client, fetchFn } = make(() => json(200, { item: { id: '7' } }), apiClient);
    await client.createCard('4', { name: 'n', description: 'd' });
    await client.updateTask('8', { isCompleted: true });
    await client.addCardLabel('7', '3');
    const calls = fetchFn.mock.calls.map(([u, i]) => `${i?.method} ${new URL(String(u)).pathname} ${i?.body}`);
    expect(calls).toEqual([
      'POST /api/lists/4/cards {"name":"n","description":"d"}',
      'PATCH /api/tasks/8 {"isCompleted":true}',
      'POST /api/cards/7/labels {"labelId":"3"}',
    ]);
  });

  it.each([
    [404, /unknown id/],
    [403, /lacks the required role/],
    [409, /already exists/],
    [429, /wait about a minute/],
    [500, /server error/],
  ])('translates HTTP %i', async (status, re) => {
    const { client } = make(() => json(status, { code: 'E', message: 'boom' }), apiClient);
    await expect(client.getCard('1')).rejects.toThrow(re);
  });

  it('retries GET on 503 but not POST', async () => {
    let g = 0;
    const a = make(() => (++g < 3 ? json(503, {}) : json(200, { item: { id: '1' } })), apiClient);
    await expect(a.client.getCard('1')).resolves.toBeDefined();
    expect(g).toBe(3);
    let p = 0;
    const b = make(() => { p++; return json(503, {}); }, apiClient);
    await expect(b.client.createComment('1', 't')).rejects.toThrow(/server error/);
    expect(p).toBe(1);
  });

  it('turns network failures into a readable error', async () => {
    const { client } = make(() => { throw new TypeError('fetch failed'); }, apiClient);
    await expect(client.createComment('1', 't')).rejects.toThrow(/Cannot reach 4ga Boards/);
  });

  it('blocks deletes unless enabled (defence in depth)', async () => {
    const off = make(() => json(200, { item: {} }), apiClient, false);
    await expect(off.client.deleteCard('1')).rejects.toThrow(/disabled/);
    await expect(off.client.deleteComment('1')).rejects.toThrow(/disabled/);
    expect(off.fetchFn).not.toHaveBeenCalled();
    const on = make(() => json(200, { item: {} }), apiClient, true);
    await on.client.deleteCard('1');
    expect(on.fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('config', () => {
  const base = { FOURGA_URL: 'https://b.test/api/' };
  it('prefers API client, normalises URL, defaults deletes off', () => {
    const c = loadConfig({ ...base, FOURGA_CLIENT_ID: 'a', FOURGA_CLIENT_SECRET: 'b', FOURGA_USERNAME: 'u', FOURGA_PASSWORD: 'p' });
    expect(c.credentials.kind).toBe('apiClient');
    expect(c.baseUrl).toBe('https://b.test');
    expect(c.allowDelete).toBe(false);
  });
  it('rejects missing/partial credentials and bad values', () => {
    expect(() => loadConfig({})).toThrow(/FOURGA_URL/);
    expect(() => loadConfig(base)).toThrow(/No credentials/);
    expect(() => loadConfig({ ...base, FOURGA_USERNAME: 'u' })).toThrow(/together/);
    expect(() => loadConfig({ ...base, FOURGA_TOKEN: 't', FOURGA_DEFAULT_BOARD_ID: 'abc' })).toThrow(/numeric/);
    expect(() => loadConfig({ ...base, FOURGA_TOKEN: 't', FOURGA_ALLOW_DELETE: 'maybe' })).toThrow(/true or false/);
  });
});
