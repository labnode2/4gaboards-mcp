import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Bearer token required on /mcp. Mandatory unless host is loopback. */
  token?: string;
  /** Extra allowed Host header values (e.g. "mcp.lan:3000") for DNS-rebinding protection. */
  allowedHosts?: string[];
  log: (msg: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_BODY = 4 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

/** Stateless Streamable HTTP: a fresh MCP server + transport per request, sharing the same API client. */
export function startHttp(makeServer: () => McpServer, opts: HttpOptions): Promise<Server> {
  if (!LOOPBACK.has(opts.host) && !opts.token) {
    throw new Error('MCP_HTTP_TOKEN is required when MCP_HTTP_HOST is not a loopback address.');
  }
  const allowed = opts.allowedHosts?.map((h) => h.toLowerCase());
  const loopbackOnly = LOOPBACK.has(opts.host);

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/healthz') return send(res, 200, { ok: true });

        const hostHeader = (req.headers.host ?? '').toLowerCase();
        const hostname = hostHeader.replace(/:\d+$/, '');
        if (allowed ? !allowed.includes(hostHeader) && !allowed.includes(hostname) : loopbackOnly && !LOOPBACK.has(hostname)) {
          return send(res, 403, { error: 'Host not allowed' });
        }
        if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found' });

        if (opts.token) {
          const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
          if (!m || !safeEqual(m[1] as string, opts.token)) {
            return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
          }
        }
        if (req.method !== 'POST') {
          return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }, { Allow: 'POST' });
        }

        const body = await readJson(req);
        const mcp = makeServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        opts.log(`http error: ${(e as Error).message}`);
        if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : (e as Error).message });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
