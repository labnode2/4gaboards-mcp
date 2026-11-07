import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FourgaClient } from '../src/api/client.js';
import { createServer } from '../src/server.js';

/** Minimal stateful fake of the 4ga Boards API (only what the tools use; mirrors docs/API_NOTES.md). */
function fakeBackend() {
  const mk = (id: string, listId: string, position: number, createdAt: string, boardId = '1') => ({
    id, boardId, listId, name: `card ${id}`, description: `desc of ${id} needle`, position, isCompleted: false,
    dueDate: null, commentCount: 0, createdAt, updatedAt: null,
  });
  const db = {
    lists: [
      { id: '10', boardId: '1', name: 'To Do', position: 1, isCompleted: false },
      { id: '11', boardId: '1', name: 'Doing', position: 2, isCompleted: false },
      { id: '12', boardId: '1', name: 'Done', position: 3, isCompleted: true },
      { id: '20', boardId: '2', name: 'Other', position: 1, isCompleted: false },
    ],
    labels: [{ id: '30', boardId: '1', name: 'bug', color: 'red' }],
    cards: [
      mk('100', '10', 65535, '2026-01-02T00:00:00Z'), // newer but on top
      mk('101', '10', 131070, '2026-01-01T00:00:00Z'), // oldest
      mk('200', '20', 65535, '2026-01-01T00:00:00Z', '2'),
    ] as ReturnType<typeof mk>[],
    tasks: [] as { id: string; cardId: string; name: string; position: number; isCompleted: boolean }[],
    cardLabels: [] as { id: string; cardId: string; labelId: string }[],
    comments: [] as { id: string; cardId: string; userId: string; data: { text: string; userName: string }; createdAt: string }[],
    seq: 1000,
    calls: [] as string[],
  };
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(input.toString());
    const m = init?.method ?? 'GET';
    const p = u.pathname.replace('/api', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    db.calls.push(`${m} ${p}`);
    let r: RegExpMatchArray | null;
    if (m === 'GET' && p === '/projects')
      return res(200, { items: [{ id: '5', name: 'P' }], included: { boards: [{ id: '1', projectId: '5', name: 'Main', position: 1 }, { id: '2', projectId: '5', name: 'Second', position: 2 }] } });
    if (m === 'GET' && (r = p.match(/^\/boards\/(\d+)$/))) {
      const b = r[1]!;
      return res(200, {
        item: { id: b, projectId: '5', name: b === '1' ? 'Main' : 'Second', position: 1 },
        included: {
          lists: db.lists.filter((l) => l.boardId === b), labels: db.labels.filter((l) => l.boardId === b),
          cards: db.cards.filter((c) => c.boardId === b), tasks: db.tasks, cardLabels: db.cardLabels,
        },
      });
    }
    if (m === 'GET' && (r = p.match(/^\/cards\/(\d+)$/))) {
      const c = db.cards.find((x) => x.id === r![1]);
      return c ? res(200, { item: c, included: { tasks: db.tasks.filter((t) => t.cardId === c.id), cardLabels: db.cardLabels.filter((l) => l.cardId === c.id) } }) : res(404, { code: 'E_NOT_FOUND', message: 'Card not found' });
    }
    if (m === 'GET' && (r = p.match(/^\/cards\/(\d+)\/comments$/))) {
      const all = db.comments.filter((c) => c.cardId === r![1]).sort((a, b) => Number(b.id) - Number(a.id));
      const before = u.searchParams.get('beforeId');
      return res(200, { items: all.filter((c) => !before || Number(c.id) < Number(before)).slice(0, 50) });
    }
    if (m === 'POST' && (r = p.match(/^\/cards\/(\d+)\/comments$/))) {
      const c = { id: String(db.seq++), cardId: r[1]!, userId: '1', data: { text: String(body.text), userName: 'Bot' }, createdAt: 'now' };
      db.comments.push(c);
      return res(200, { item: c });
    }
    if (m === 'DELETE' && (r = p.match(/^\/comments\/(\d+)$/))) {
      db.comments = db.comments.filter((c) => c.id !== r![1]);
      return res(200, { item: {} });
    }
    if (m === 'POST' && (r = p.match(/^\/lists\/(\d+)\/cards$/))) {
      const l = db.lists.find((x) => x.id === r![1]);
      if (!l) return res(404, { message: 'List not found' });
      const c = { ...mk(String(db.seq++), l.id, 999999, 'now', l.boardId), name: String(body.name) };
      db.cards.push(c);
      return res(200, { item: c });
    }
    if (m === 'PATCH' && (r = p.match(/^\/cards\/(\d+)$/))) {
      const c = db.cards.find((x) => x.id === r![1])!;
      if (body.listId !== undefined) {
        if (body.position === undefined) return res(422, { code: 'E_UNPROCESSABLE_ENTITY', message: 'Position must be present' });
        const l = db.lists.find((x) => x.id === body.listId && x.boardId === c.boardId);
        if (!l) return res(404, { message: 'List not found' });
        c.listId = l.id;
        c.isCompleted = l.isCompleted;
      }
      for (const k of ['name', 'description', 'dueDate', 'position'] as const) if (body[k] !== undefined) (c as Record<string, unknown>)[k] = body[k];
      return res(200, { item: c });
    }
    if (m === 'DELETE' && (r = p.match(/^\/cards\/(\d+)$/))) {
      db.cards = db.cards.filter((c) => c.id !== r![1]);
      return res(200, { item: {} });
    }
    if (m === 'POST' && (r = p.match(/^\/cards\/(\d+)\/tasks$/))) {
      const t = { id: String(db.seq++), cardId: r[1]!, name: String(body.name), position: 65535, isCompleted: false };
      db.tasks.push(t);
      return res(200, { item: t });
    }
    if (m === 'PATCH' && (r = p.match(/^\/tasks\/(\d+)$/))) {
      const t = db.tasks.find((x) => x.id === r![1]);
      if (!t) return res(404, { message: 'Task not found' });
      t.isCompleted = Boolean(body.isCompleted);
      return res(200, { item: t });
    }
    if (m === 'POST' && (r = p.match(/^\/cards\/(\d+)\/labels$/))) {
      if (db.cardLabels.some((l) => l.cardId === r![1] && l.labelId === body.labelId)) return res(409, { message: 'Label already in card' });
      const cl = { id: String(db.seq++), cardId: r[1]!, labelId: String(body.labelId) };
      db.cardLabels.push(cl);
      return res(200, { item: cl });
    }
    if (m === 'DELETE' && (r = p.match(/^\/cards\/(\d+)\/labels\/(\d+)$/))) {
      db.cardLabels = db.cardLabels.filter((l) => !(l.cardId === r![1] && l.labelId === r![2]));
      return res(200, { item: {} });
    }
    return res(404, { message: `unhandled ${m} ${p}` });
  }) as unknown as typeof fetch;
  return { db, fetchFn };
}

async function connect(opts: { allowDelete?: boolean; focusBoardId?: string } = {}) {
  const be = fakeBackend();
  const client = new FourgaClient(
    { baseUrl: 'http://x.test', credentials: { kind: 'apiClient', clientId: 'a', clientSecret: 'b' }, allowDelete: opts.allowDelete ?? false, timeoutMs: 5000 },
    { fetchFn: be.fetchFn },
  );
  const server = createServer({ client, allowDelete: opts.allowDelete ?? false, focusBoardId: opts.focusBoardId });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return { error: r.isError === true, text, json: r.isError ? undefined : (JSON.parse(text) as any) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { be, mcp, call };
}

describe('tool registry', () => {
  it('hides delete tools unless FOURGA_ALLOW_DELETE', async () => {
    const off = await connect();
    const names = (await off.mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_projects', 'get_board', 'claim_next_card', 'move_card', 'toggle_task']));
    expect(names).not.toContain('delete_card');
    expect(names).not.toContain('delete_comment');
    const on = await connect({ allowDelete: true });
    const onNames = (await on.mcp.listTools()).tools.map((t) => t.name);
    expect(onNames).toEqual(expect.arrayContaining(['delete_card', 'delete_comment']));
    for (const t of (await on.mcp.listTools()).tools) expect(t.description!.length).toBeGreaterThan(30);
  });
});

describe('read tools', () => {
  it('get_board returns compact lists + card summaries', async () => {
    const { call } = await connect();
    const r = await call('get_board', { board_id: '1' });
    expect(r.json.lists.map((l: { name: string }) => l.name)).toEqual(['To Do', 'Doing', 'Done']);
    expect(r.json.lists[0].cards.map((c: { id: string }) => c.id)).toEqual(['100', '101']);
    expect(r.text).not.toContain('desc of');
    expect(r.text).not.toContain('null');
  });

  it('get_card has tasks, labels with names, comments oldest-first', async () => {
    const { call } = await connect();
    await call('create_task', { card_id: '100', name: 'step' });
    await call('add_label', { card_id: '100', label: 'BUG' });
    await call('add_comment', { card_id: '100', text: 'one' });
    await call('add_comment', { card_id: '100', text: 'two' });
    const r = await call('get_card', { card_id: '100' });
    expect(r.json.labels[0]).toMatchObject({ name: 'bug', color: 'red' });
    expect(r.json.tasks).toEqual([expect.objectContaining({ name: 'step', done: false })]);
    expect(r.json.comments.map((c: { text: string }) => c.text)).toEqual(['one', 'two']);
    expect(r.json.list.name).toBe('To Do');
  });

  it('list_cards filters by list name and label; search_cards finds text', async () => {
    const { call } = await connect();
    await call('add_label', { card_id: '101', label: '30' });
    expect((await call('list_cards', { board_id: '1', list: 'to do', label: 'bug' })).json.cards.map((c: { id: string }) => c.id)).toEqual(['101']);
    expect((await call('list_cards', { board_id: '1' })).json.total).toBe(2);
    expect((await call('list_cards', { board_id: '1', list: 'nope' })).text).toMatch(/Available: .*To Do/);
    const s = await call('search_cards', { query: 'NEEDLE 101' });
    expect(s.json.cards.map((c: { id: string }) => c.id)).toEqual(['101']);
    expect(s.json.total).toBe(1);
  });
});

describe('write tools', () => {
  it('create_card, update_card (clears description), comment', async () => {
    const { call, be } = await connect();
    const c = await call('create_card', { list_id: '10', name: 'New', description: 'hello' });
    expect(c.json.listId).toBe('10');
    await call('update_card', { card_id: c.json.id, name: 'Renamed', description: '' });
    expect(be.db.cards.find((x) => x.id === c.json.id)).toMatchObject({ name: 'Renamed', description: null });
    expect((await call('update_card', { card_id: c.json.id })).text).toMatch(/Nothing to update/);
  });

  it('move_card supplies a position (API requires it) and respects top/bottom', async () => {
    const { call, be } = await connect();
    const r = await call('move_card', { card_id: '100', list_id: '11' });
    expect(r.json.list.name).toBe('Doing');
    expect(be.db.cards.find((c) => c.id === '100')!.position).toBe(65535);
    await call('move_card', { card_id: '101', list_id: '11' });
    expect(be.db.cards.find((c) => c.id === '101')!.position).toBe(131070);
    await call('move_card', { card_id: '101', list_id: '11', position: 'top' });
    expect(be.db.cards.find((c) => c.id === '101')!.position).toBeLessThan(65535);
    const done = await call('move_card', { card_id: '100', list_id: '12' });
    expect(done.json.done).toBe(true);
    expect((await call('move_card', { card_id: '100', list_id: '20' })).text).toMatch(/not on this card's board/);
  });

  it('toggle_task, add/remove label and conflict message', async () => {
    const { call } = await connect();
    const t = await call('create_task', { card_id: '100', name: 'x' });
    expect((await call('toggle_task', { task_id: t.json.id, done: true })).json.done).toBe(true);
    await call('add_label', { card_id: '100', label: 'bug' });
    expect((await call('add_label', { card_id: '100', label: 'bug' })).text).toMatch(/Conflict \(409\)/);
    await call('remove_label', { card_id: '100', label: 'bug' });
    expect((await call('get_card', { card_id: '100' })).json.labels).toEqual([]);
    expect((await call('get_card', { card_id: '999' })).text).toMatch(/unknown id/);
  });

  it('validates ids with zod', async () => {
    const { mcp } = await connect();
    const r = await mcp.callTool({ name: 'get_card', arguments: { card_id: 'abc' } });
    expect(r.isError).toBe(true);
  });

  it('delete tools work when enabled; delete_comment verifies the card', async () => {
    const { call, be } = await connect({ allowDelete: true });
    const cm = await call('add_comment', { card_id: '100', text: 'bye' });
    expect((await call('delete_comment', { card_id: '101', comment_id: cm.json.id })).text).toMatch(/not found on card/);
    expect(be.db.comments).toHaveLength(1);
    await call('delete_comment', { card_id: '100', comment_id: cm.json.id });
    expect(be.db.comments).toHaveLength(0);
    await call('delete_card', { card_id: '101' });
    expect(be.db.cards.some((c) => c.id === '101')).toBe(false);
  });
});

describe('claim_next_card', () => {
  it('claims the oldest card (by created date), moves it, returns details', async () => {
    const { call, be } = await connect();
    const r = await call('claim_next_card', { board_id: '1', from_list: 'To Do', to_list: 'Doing' });
    expect(r.json.claimed).toBe(true);
    expect(r.json.card.id).toBe('101');
    expect(r.json.card.list.name).toBe('Doing');
    expect(be.db.cards.find((c) => c.id === '101')!.listId).toBe('11');
  });

  it('supports position order and returns claimed:false when empty', async () => {
    const { call } = await connect();
    expect((await call('claim_next_card', { board_id: '1', from_list: '10', to_list: '11', order: 'position' })).json.card.id).toBe('100');
    await call('claim_next_card', { board_id: '1', from_list: '10', to_list: '11' });
    const empty = await call('claim_next_card', { board_id: '1', from_list: '10', to_list: '11' });
    expect(empty.json.claimed).toBe(false);
    expect((await call('claim_next_card', { board_id: '1', from_list: 'Doing', to_list: 'doing' })).text).toMatch(/same list/);
  });

  it('concurrent claims never hand out the same card', async () => {
    const { call } = await connect();
    const rs = await Promise.all([1, 2, 3].map(() => call('claim_next_card', { board_id: '1', from_list: 'To Do', to_list: 'Doing' })));
    const ids = rs.filter((r) => r.json.claimed).map((r) => r.json.card.id).sort();
    expect(ids).toEqual(['100', '101']);
    expect(rs.filter((r) => !r.json.claimed)).toHaveLength(1);
  });
});

describe('focus mode', () => {
  it('scopes listings and rejects other boards', async () => {
    const { call, be } = await connect({ focusBoardId: '1' });
    expect((await call('list_boards')).json.map((b: { id: string }) => b.id)).toEqual(['1']);
    expect((await call('get_board')).json.id).toBe('1');
    expect((await call('get_board', { board_id: '2' })).text).toMatch(/Focus mode/);
    expect((await call('get_card', { card_id: '200' })).text).toMatch(/not on the focus board/);
    expect((await call('add_comment', { card_id: '200', text: 'x' })).error).toBe(true);
    expect((await call('create_card', { list_id: '20', name: 'x' })).text).toMatch(/not on the focus board/);
    expect((await call('create_card', { list_id: '10', name: 'ok' })).error).toBe(false);
    expect((await call('claim_next_card', { from_list: 'To Do', to_list: 'Doing' })).json.claimed).toBe(true);
    expect(be.db.comments).toHaveLength(0);
  });
});
