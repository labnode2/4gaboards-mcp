import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError } from '../api/errors.js';
import type { BoardSnapshot } from '../api/types.js';
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  cardDetails,
  cardSummary,
  defineTool,
  idSchema,
  isoDateSchema,
  loadCard,
  resolveBoardId,
  resolveLabel,
  resolveList,
  snippet,
  targetPosition,
  type Ctx,
} from './shared.js';

const MAX_SEARCH_BOARDS = 20;

export function registerCardTools(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    'list_cards',
    'List cards',
    'List card summaries on a board, optionally filtered by list, label, completion or due date. The API cannot list by list id alone, so a board is required (optional in focus mode). Ordered by list then position. Use get_card for descriptions, tasks and comments.',
    {
      board_id: idSchema('Board id').optional(),
      list: z.string().trim().min(1).optional().describe('Only cards in this list: list id or exact list name'),
      label: z.string().trim().min(1).optional().describe('Only cards with this label: label id or exact label name'),
      is_completed: z.boolean().optional().describe('true = only completed cards, false = only open cards'),
      due_before: isoDateSchema.optional().describe('Only cards with a due date before this ISO date'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    READ,
    async ({ board_id, list, label, is_completed, due_before, limit }) => {
      const s = await ctx.client.getBoard(resolveBoardId(ctx, board_id) as string);
      const listId = list ? resolveList(s, list).id : undefined;
      const labelId = label ? resolveLabel(s, label).id : undefined;
      const withLabel = labelId ? new Set(s.cardLabels.filter((cl) => cl.labelId === labelId).map((cl) => cl.cardId)) : undefined;
      const order = new Map(s.lists.map((l, i) => [l.id, i]));
      const matches = s.cards
        .filter((c) => !listId || c.listId === listId)
        .filter((c) => !withLabel || withLabel.has(c.id))
        .filter((c) => is_completed === undefined || c.isCompleted === is_completed)
        .filter((c) => !due_before || (c.dueDate !== null && Date.parse(c.dueDate) < Date.parse(due_before)))
        .sort((a, b) => (order.get(a.listId) ?? 0) - (order.get(b.listId) ?? 0) || a.position - b.position);
      return {
        total: matches.length,
        cards: matches.slice(0, limit).map((c) => cardSummary(s, c)),
        truncated: matches.length > limit ? true : undefined,
      };
    },
  );

  defineTool(
    server,
    'get_card',
    'Get card details',
    'Get everything about one card: description, list, labels (with names), assigned members, tasks (checklist items with done state) and the most recent comments (oldest first).',
    {
      card_id: idSchema('Card id'),
      comment_limit: z.number().int().min(0).max(50).default(20).describe('How many of the newest comments to include'),
    },
    READ,
    ({ card_id, comment_limit }) => cardDetails(ctx, card_id, comment_limit),
  );

  defineTool(
    server,
    'search_cards',
    'Search cards',
    `Case-insensitive text search over card names and descriptions (all words must match). 4ga Boards has no search endpoint, so this scans board snapshots client-side: pass board_id when you can; without it at most ${MAX_SEARCH_BOARDS} accessible boards are scanned.`,
    {
      query: z.string().trim().min(1).describe('Words to look for'),
      board_id: idSchema('Board id').optional().describe('Limit to one board (recommended)'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    READ,
    async ({ query, board_id, limit }) => {
      const boardId = resolveBoardId(ctx, board_id, false);
      let ids: string[];
      let note: string | undefined;
      if (boardId) ids = [boardId];
      else {
        const all = (await ctx.client.listProjects()).boards;
        ids = all.slice(0, MAX_SEARCH_BOARDS).map((b) => b.id);
        if (all.length > MAX_SEARCH_BOARDS) note = `Only the first ${MAX_SEARCH_BOARDS} of ${all.length} boards were searched; pass board_id.`;
      }
      const terms = query.toLowerCase().split(/\s+/);
      const snaps: BoardSnapshot[] = await Promise.all(ids.map((id) => ctx.client.getBoard(id)));
      const hits = snaps.flatMap((s) =>
        s.cards
          .filter((c) => {
            const hay = `${c.name}\n${c.description ?? ''}`.toLowerCase();
            return terms.every((t) => hay.includes(t));
          })
          .map((c) => ({ board: s.board.name, boardId: s.board.id, ...cardSummary(s, c), snippet: snippet(c.description) })),
      );
      return { total: hits.length, cards: hits.slice(0, limit), truncated: hits.length > limit ? true : undefined, note };
    },
  );

  defineTool(
    server,
    'create_card',
    'Create card',
    'Create a card at the bottom of a list. Needs an editor role on the board. Get list ids from get_board.',
    {
      list_id: idSchema('List id'),
      name: z.string().trim().min(1).max(1024).describe('Card title'),
      description: z.string().trim().min(1).optional().describe('Markdown description'),
      due_date: isoDateSchema.optional(),
    },
    WRITE,
    async ({ list_id, name, description, due_date }) => {
      if (ctx.focusBoardId) {
        const s = await ctx.client.getBoard(ctx.focusBoardId);
        if (!s.lists.some((l) => l.id === list_id)) {
          throw new UserError(`List ${list_id} is not on the focus board ${ctx.focusBoardId}. Lists: ${s.lists.map((l) => `${l.id}="${l.name}"`).join(', ')}`);
        }
      }
      const c = await ctx.client.createCard(list_id, { name, description, dueDate: due_date });
      return { id: c.id, name: c.name, listId: c.listId, boardId: c.boardId, position: c.position };
    },
  );

  defineTool(
    server,
    'update_card',
    'Update card',
    'Change a card\'s name, description and/or due date. Only the fields you pass are changed. Pass description "" or due_date null to clear them. To change list/position use move_card; for tasks, labels and comments use their tools.',
    {
      card_id: idSchema('Card id'),
      name: z.string().trim().min(1).max(1024).optional(),
      description: z.string().nullable().optional().describe('Markdown; "" or null clears'),
      due_date: isoDateSchema.nullable().optional().describe('ISO-8601; null clears'),
    },
    { ...WRITE, idempotentHint: true },
    async ({ card_id, name, description, due_date }) => {
      if (name === undefined && description === undefined && due_date === undefined) {
        throw new UserError('Nothing to update: pass at least one of name, description, due_date.');
      }
      await loadCard(ctx, card_id);
      const c = await ctx.client.updateCard(card_id, {
        name,
        description: description === undefined ? undefined : description === null || description.trim() === '' ? null : description,
        dueDate: due_date,
      });
      return { id: c.id, name: c.name, description: snippet(c.description, 300), due: c.dueDate, updated: c.updatedAt };
    },
  );

  defineTool(
    server,
    'move_card',
    'Move card',
    'Move a card to another list of the same board. position: "bottom" (default), "top", or a number (lower = higher; mostly for advanced use). Moving into a "completed" list marks the card completed. Cross-board moves are not supported.',
    {
      card_id: idSchema('Card id'),
      list_id: idSchema('Destination list id'),
      position: z.union([z.enum(['top', 'bottom']), z.number().finite()]).default('bottom'),
    },
    { ...WRITE, idempotentHint: true },
    async ({ card_id, list_id, position }) => {
      const card = await loadCard(ctx, card_id);
      const s = await ctx.client.getBoard(card.boardId);
      const list = s.lists.find((l) => l.id === list_id);
      if (!list) {
        throw new UserError(`List ${list_id} is not on this card's board (${s.board.id}). Lists: ${s.lists.map((l) => `${l.id}="${l.name}"`).join(', ')}`);
      }
      const others = s.cards.filter((c) => c.listId === list.id && c.id !== card.id);
      const moved = await ctx.client.updateCard(card_id, { listId: list.id, position: targetPosition(others, position) });
      return { id: moved.id, name: moved.name, list: { id: list.id, name: list.name }, position: moved.position, done: moved.isCompleted || undefined };
    },
  );

  if (ctx.allowDelete) {
    defineTool(
      server,
      'delete_card',
      'Delete card',
      'PERMANENTLY delete a card (with its tasks, comments and attachments). Cannot be undone. Only use when the user explicitly asked for deletion.',
      { card_id: idSchema('Card id') },
      DESTRUCTIVE,
      async ({ card_id }) => {
        const card = await loadCard(ctx, card_id);
        await ctx.client.deleteCard(card_id);
        return { deleted: true, id: card.id, name: card.name };
      },
    );
  }
}
