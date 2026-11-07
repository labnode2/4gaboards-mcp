/**
 * Integration smoke test against a REAL 4ga Boards instance, through the MCP server itself
 * (spawns dist/ over stdio, or src/ via tsx if dist is missing).
 *
 *   FOURGA_URL=... FOURGA_CLIENT_ID=... FOURGA_CLIENT_SECRET=... npm run smoke
 *   optional: SMOKE_BOARD_ID (default: first board), SMOKE_FROM_LIST / SMOKE_TO_LIST (names or ids),
 *             FOURGA_ALLOW_DELETE=true to also delete the test card.
 * It creates one card prefixed "[mcp-smoke]" and (if deletes are off) leaves it in the board for manual cleanup.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist/index.js`;
const [command, args] = existsSync(dist) ? ['node', [dist]] : ['npx', ['tsx', `${root}src/index.ts`]];

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
const allowDelete = env.FOURGA_ALLOW_DELETE === 'true';

let failures = 0;
const step = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

const mcp = new Client({ name: 'smoke', version: '0' });
await mcp.connect(new StdioClientTransport({ command, args, env, stderr: 'inherit' }));

async function call(name: string, a: Record<string, unknown> = {}) {
  const r = await mcp.callTool({ name, arguments: a });
  const text = (r.content as { text: string }[])[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

let cardId: string | undefined;
try {
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  step('tools listed', tools.includes('claim_next_card'), `${tools.length} tools; delete tools ${tools.includes('delete_card') ? 'on' : 'off'}`);

  const boards = await call('list_boards');
  step('list_boards', Array.isArray(boards) && boards.length > 0, `${boards.length} board(s)`);
  const boardId: string = env.SMOKE_BOARD_ID ?? env.FOURGA_DEFAULT_BOARD_ID ?? boards[0].id;

  const board = await call('get_board', { board_id: boardId, include_cards: false });
  const lists: { id: string; name: string }[] = board.lists;
  step('get_board', lists.length >= 2, `"${board.name}" lists: ${lists.map((l) => l.name).join(' | ')}`);
  const from = lists.find((l) => l.name === env.SMOKE_FROM_LIST || l.id === env.SMOKE_FROM_LIST) ?? lists[0]!;
  const to = lists.find((l) => l.name === env.SMOKE_TO_LIST || l.id === env.SMOKE_TO_LIST) ?? lists[1]!;

  const created = await call('create_card', { list_id: from.id, name: `[mcp-smoke] ${new Date().toISOString()}`, description: 'Created by scripts/smoke.ts' });
  cardId = created.id;
  step('create_card', !!cardId, `id ${cardId} in "${from.name}"`);

  await call('add_comment', { card_id: cardId, text: 'smoke comment' });
  await call('create_task', { card_id: cardId, name: 'smoke task' });
  let card = await call('get_card', { card_id: cardId });
  step('comment + task visible', card.comments.some((c: { text: string }) => c.text === 'smoke comment') && card.tasks.length === 1);
  await call('toggle_task', { task_id: card.tasks[0].id, done: true });
  card = await call('get_card', { card_id: cardId });
  step('toggle_task', card.tasks[0].done === true);

  await call('update_card', { card_id: cardId, description: 'updated by smoke' });
  step('search_cards finds it', (await call('search_cards', { query: 'mcp-smoke', board_id: boardId })).cards.some((c: { id: string }) => c.id === cardId));

  await call('move_card', { card_id: cardId, list_id: to.id });
  card = await call('get_card', { card_id: cardId });
  step('move_card', card.list.id === to.id, `now in "${card.list.name}"`);

  if (allowDelete) {
    await call('delete_comment', { card_id: cardId, comment_id: card.comments[0].id });
    await call('delete_card', { card_id: cardId });
    cardId = undefined;
    step('delete_comment + delete_card', true);
  } else {
    step('delete skipped', true, `FOURGA_ALLOW_DELETE is not true; remove card ${cardId} manually`);
  }
} catch (e) {
  step('unexpected error', false, e instanceof Error ? e.message : String(e));
} finally {
  await mcp.close();
}
console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
