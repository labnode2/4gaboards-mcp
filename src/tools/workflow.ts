import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError } from '../api/errors.js';
import { WRITE, cardDetails, defineTool, idSchema, resolveBoardId, resolveList, targetPosition, type Ctx } from './shared.js';

/** Serialises claims per (board, from-list) inside this process. */
const chains = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

const MAX_ATTEMPTS = 5;

export function registerWorkflowTools(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    'claim_next_card',
    'Claim next card',
    'Task pickup: take the next card from one list, move it to another (e.g. "To Do" -> "In Progress") and return its full details. Returns {"claimed":false} when the source list is empty. Safe against concurrent callers in the same server process; across several server processes there is a small race window (the 4ga API has no atomic claim). "oldest" order (default) = earliest created first; "position" = top of the list first.',
    {
      board_id: idSchema('Board id').optional().describe('Optional in focus mode'),
      from_list: z.string().trim().min(1).describe('Source list: id or exact name'),
      to_list: z.string().trim().min(1).describe('Destination list: id or exact name'),
      order: z.enum(['oldest', 'position']).default('oldest'),
    },
    WRITE,
    async ({ board_id, from_list, to_list, order }) => {
      const boardId = resolveBoardId(ctx, board_id) as string;
      return exclusive(`${boardId}:${from_list.toLowerCase()}`, async () => {
        const s = await ctx.client.getBoard(boardId);
        const from = resolveList(s, from_list);
        const to = resolveList(s, to_list);
        if (from.id === to.id) throw new UserError('from_list and to_list are the same list.');

        const created = (c: { createdAt: string | null }) => (c.createdAt ? Date.parse(c.createdAt) : 0);
        const queue = s.cards
          .filter((c) => c.listId === from.id)
          .sort((a, b) =>
            order === 'oldest'
              ? created(a) - created(b) || a.position - b.position || Number(BigInt(a.id) - BigInt(b.id))
              : a.position - b.position,
          );
        if (queue.length === 0) return { claimed: false, reason: `List "${from.name}" is empty.` };

        const dest = s.cards.filter((c) => c.listId === to.id);
        for (const cand of queue.slice(0, MAX_ATTEMPTS)) {
          // Re-read right before moving: if another worker already took it, try the next card.
          const fresh = (await ctx.client.getCard(cand.id)).card;
          if (fresh.listId !== from.id) continue;
          await ctx.client.updateCard(cand.id, { listId: to.id, position: targetPosition(dest, 'bottom') });
          const details = await cardDetails(ctx, cand.id);
          return { claimed: true, from: from.name, to: to.name, card: details };
        }
        return { claimed: false, reason: `The first ${MAX_ATTEMPTS} cards in "${from.name}" were taken by someone else meanwhile; retry.` };
      });
    },
  );
}
