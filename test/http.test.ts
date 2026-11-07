import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { FourgaClient } from '../src/api/client.js';
import { startHttp } from '../src/http-server.js';
import { createServer } from '../src/server.js';

const client = new FourgaClient(
  { baseUrl: 'http://x.test', credentials: { kind: 'token', token: 't' }, allowDelete: false, timeoutMs: 1000 },
  { fetchFn: (async () => new Response(JSON.stringify({ items: [], included: { boards: [] } }))) as unknown as typeof fetch },
);
const make = () => createServer({ client, allowDelete: false });
let closer: { close(): void } | undefined;
afterEach(() => closer?.close());

async function up(token?: string) {
  const srv = await startHttp(make, { host: '127.0.0.1', port: 0, token, log: () => undefined });
  closer = srv;
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

describe('streamable http', () => {
  it('serves tools to an MCP client with the bearer token', async () => {
    const base = await up('s3cret');
    const c = new Client({ name: 't', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer s3cret' } } }));
    expect((await c.listTools()).tools.length).toBeGreaterThan(10);
    const r = await c.callTool({ name: 'list_projects', arguments: {} });
    expect(r.isError).toBeFalsy();
    await c.close();
  });

  it('rejects missing/wrong token, non-POST, wrong path; health is open', async () => {
    const base = await up('s3cret');
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(405);
    expect((await fetch(`${base}/other`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('blocks foreign Host headers on loopback (DNS rebinding)', async () => {
    const base = await up();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/mcp`);
      const r = request({ host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
  });

  it('refuses to start on a public interface without a token', () => {
    expect(() => startHttp(make, { host: '0.0.0.0', port: 0, log: () => undefined })).toThrow(/MCP_HTTP_TOKEN/);
  });
});
