/** Minimal stateful fake of the 4ga Boards API (only what the tools use; mirrors docs/API_NOTES.md). */
export function fakeBackend() {
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
    users: [{ id: '70', name: 'Alice Martin', username: 'alice', email: 'a@x.io' }, { id: '71', name: 'Bob', username: 'bob', email: 'b@x.io' }, { id: '72', name: 'Outsider', username: 'out', email: 'o@x.io' }],
    boardMemberships: [{ id: '80', boardId: '1', userId: '70', role: 'editor' }, { id: '81', boardId: '1', userId: '71', role: 'viewer' }],
    cardMemberships: [] as { id: string; cardId: string; userId: string }[],
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
          users: db.users, boardMemberships: db.boardMemberships, cardMemberships: db.cardMemberships,
        },
      });
    }
    if (m === 'GET' && (r = p.match(/^\/cards\/(\d+)$/))) {
      const c = db.cards.find((x) => x.id === r![1]);
      return c ? res(200, { item: c, included: { tasks: db.tasks.filter((t) => t.cardId === c.id), cardLabels: db.cardLabels.filter((l) => l.cardId === c.id), cardMemberships: db.cardMemberships.filter((x) => x.cardId === c.id) } }) : res(404, { code: 'E_NOT_FOUND', message: 'Card not found' });
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
    if (m === 'POST' && (r = p.match(/^\/cards\/(\d+)\/memberships$/))) {
      if (db.cardMemberships.some((x) => x.cardId === r![1] && x.userId === body.userId)) return res(409, { message: 'User already card member' });
      const cm = { id: String(db.seq++), cardId: r[1]!, userId: String(body.userId) };
      db.cardMemberships.push(cm);
      return res(200, { item: cm });
    }
    if (m === 'DELETE' && (r = p.match(/^\/cards\/(\d+)\/memberships$/))) {
      const uid = u.searchParams.get('userId');
      if (!db.cardMemberships.some((x) => x.cardId === r![1] && x.userId === uid)) return res(404, { message: 'User not card member' });
      db.cardMemberships = db.cardMemberships.filter((x) => !(x.cardId === r![1] && x.userId === uid));
      return res(200, { item: {} });
    }
    return res(404, { message: `unhandled ${m} ${p}` });
  }) as unknown as typeof fetch;
  return { db, fetchFn };
}

