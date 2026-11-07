#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FourgaClient } from './api/client.js';
import { loadConfig } from './config.js';
import { startHttp } from './http-server.js';
import { VERSION, createServer } from './server.js';

// stdout is the protocol channel in stdio mode: only ever log to stderr, and never log secrets.
const log = (msg: string) => process.stderr.write(`[4gaboards-mcp] ${msg}\n`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write('4gaboards-mcp: MCP server for 4ga Boards. Configure via env (see README). Use --http for Streamable HTTP, default is stdio.\n');
    return;
  }
  if (args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cfg = loadConfig();
  const client = new FourgaClient(cfg);
  const ctx = { client, focusBoardId: cfg.defaultBoardId, allowDelete: cfg.allowDelete };
  const useHttp = args.includes('--http') || process.env.MCP_TRANSPORT === 'http';

  if (useHttp) {
    const host = process.env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
    const port = Number(process.env.MCP_HTTP_PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_HTTP_PORT must be a valid port');
    await startHttp(() => createServer(ctx), {
      host,
      port,
      token: process.env.MCP_HTTP_TOKEN?.trim() || undefined,
      allowedHosts: process.env.MCP_HTTP_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean),
      log,
    });
    log(`Streamable HTTP listening on http://${host}:${port}/mcp (target ${cfg.baseUrl}, deletes ${cfg.allowDelete ? 'ENABLED' : 'disabled'}${cfg.defaultBoardId ? `, focus board ${cfg.defaultBoardId}` : ''})`);
    return;
  }

  await createServer(ctx).connect(new StdioServerTransport());
  log(`stdio ready (target ${cfg.baseUrl}, deletes ${cfg.allowDelete ? 'ENABLED' : 'disabled'}${cfg.defaultBoardId ? `, focus board ${cfg.defaultBoardId}` : ''})`);
}

main().catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
