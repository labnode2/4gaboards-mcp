import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FourgaClient } from '../api/client.js';
import { ApiError, UserError } from '../api/errors.js';
import type { BoardSnapshot, Card, Label, List, User } from '../api/types.js';

export interface Ctx {
  client: FourgaClient;
  /** Focus mode: every tool is restricted to this board. */
  focusBoardId?: string;
  allowDelete: boolean;
}

export const POSITION_GAP = 65535;

export const idSchema = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${what} must be a numeric id string, e.g. "1234"`)
    .describe(`${what} (numeric id as a string)`);

export const isoDateSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    'must be ISO-8601, e.g. "2026-12-31" or "2026-12-31T17:00:00Z"',
  );

/** Compact JSON result; null/undefined fields are dropped. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, (_k, v: unknown) => (v === null || v === undefined ? undefined : v)) }] };
}

export function fail(e: unknown): CallToolResult {
  let msg: string;
  if (e instanceof ApiError || e instanceof UserError) msg = e.message;
  else msg = 'Unexpected error: ' + (e instanceof Error ? e.message : String(e));
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  shape: S,
  annotations: ToolAnnotations,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    { title, description, inputSchema: shape, annotations: { openWorldHint: false, ...annotations } },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    }) as never,
  );
}

export const READ: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

export function resolveBoardId(ctx: Ctx, given: string | undefined, required = true): string | undefined {
  if (ctx.focusBoardId) {
    if (given && given !== ctx.focusBoardId) {
      throw new UserError(`Focus mode: this server is restricted to board ${ctx.focusBoardId}; board ${given} is not accessible.`);
    }
    return ctx.focusBoardId;
  }
  if (!given && required) throw new UserError('board_id is required (use list_boards to find it).');
  return given;
}

/** Fetch a card and enforce focus mode. */
export async function loadCard(ctx: Ctx, cardId: string): Promise<Card> {
  const { card } = await ctx.client.getCard(cardId);
  if (ctx.focusBoardId && card.boardId !== ctx.focusBoardId) {
    // Same answer as a real 404 so the card's existence outside the focus board is not revealed.
    throw new UserError(`Not found: card ${cardId} is not on the focus board ${ctx.focusBoardId}.`);
  }
  return card;
}

const lc = (s: string) => s.trim().toLowerCase();

function pick<T extends { id: string }>(items: T[], ref: string, name: (t: T) => string | null, kind: string, board: string): T {
  const r = ref.trim();
  const byId = /^\d+$/.test(r) ? items.find((i) => i.id === r) : undefined;
  if (byId) return byId;
  const byName = items.filter((i) => name(i) !== null && lc(name(i) as string) === lc(r));
  if (byName.length === 1) return byName[0] as T;
  const avail = items.map((i) => `${i.id}="${name(i) ?? ''}"`).join(', ');
  if (byName.length > 1) throw new UserError(`${kind} "${ref}" is ambiguous on board ${board}; use the id. Candidates: ${avail}`);
  throw new UserError(`Unknown ${kind} "${ref}" on board ${board}. Available: ${avail || '(none)'}`);
}

export const resolveList = (s: BoardSnapshot, ref: string): List => pick(s.lists, ref, (l) => l.name, 'list', s.board.id);
export const resolveLabel = (s: BoardSnapshot, ref: string): Label => pick(s.labels, ref, (l) => l.name, 'label', s.board.id);
export const resolveMember = (s: BoardSnapshot, ref: string): User => {
  const r = ref.trim().replace(/^@/, '');
  const byUsername = s.members.filter((u) => u.username !== null && lc(u.username) === lc(r));
  if (byUsername.length === 1) return byUsername[0] as User;
  return pick(s.members, r, (u) => u.name ?? u.username, 'member', s.board.id);
};

export const memberView = (u: User) => ({ id: u.id, name: u.name, username: u.username });

export function cardSummary(s: BoardSnapshot, c: Card) {
  const list = s.lists.find((l) => l.id === c.listId);
  const labelIds = new Set(s.cardLabels.filter((cl) => cl.cardId === c.id).map((cl) => cl.labelId));
  const labels = s.labels.filter((l) => labelIds.has(l.id)).map((l) => l.name ?? l.color);
  const tasks = s.tasks.filter((t) => t.cardId === c.id);
  return {
    id: c.id,
    name: c.name,
    listId: c.listId,
    list: list?.name,
    position: c.position,
    done: c.isCompleted || undefined,
    due: c.dueDate,
    labels: labels.length ? labels : undefined,
    tasks: tasks.length ? `${tasks.filter((t) => t.isCompleted).length}/${tasks.length}` : undefined,
    comments: c.commentCount || undefined,
    created: c.createdAt,
    updated: c.updatedAt,
  };
}

export function snippet(text: string | null | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Position that puts a card at the end / start of a list (other cards = those already in it). */
export function targetPosition(others: Card[], where: 'top' | 'bottom' | number): number {
  if (typeof where === 'number') return where;
  if (others.length === 0) return POSITION_GAP;
  if (where === 'bottom') return Math.max(...others.map((c) => c.position)) + POSITION_GAP;
  return Math.min(...others.map((c) => c.position)) / 2;
}

/** Full card view used by get_card and claim_next_card. */
export async function cardDetails(ctx: Ctx, cardId: string, commentLimit = 20) {
  const loaded = await ctx.client.getCard(cardId);
  const card = loaded.card;
  if (ctx.focusBoardId && card.boardId !== ctx.focusBoardId) {
    throw new UserError(`Not found: card ${cardId} is not on the focus board ${ctx.focusBoardId}.`);
  }
  const [snap, newestFirst] = await Promise.all([ctx.client.getBoard(card.boardId), ctx.client.listComments(cardId)]);
  const list = snap.lists.find((l) => l.id === card.listId);
  const labelIds = new Set(loaded.cardLabels.map((cl) => cl.labelId));
  const memberIds = new Set(loaded.cardMemberships.map((m) => m.userId));
  const comments = newestFirst.slice(0, commentLimit).reverse();
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    board: { id: snap.board.id, name: snap.board.name },
    list: list ? { id: list.id, name: list.name, isCompleted: list.isCompleted || undefined } : { id: card.listId },
    done: card.isCompleted || undefined,
    due: card.dueDate,
    created: card.createdAt,
    updated: card.updatedAt,
    labels: snap.labels.filter((l) => labelIds.has(l.id)).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    members: snap.members.filter((u) => memberIds.has(u.id)).map(memberView),
    tasks: [...loaded.tasks]
      .sort((a, b) => a.position - b.position)
      .map((t) => ({ id: t.id, name: t.name, done: t.isCompleted })),
    comments: comments.map((c) => ({ id: c.id, author: c.data.userName, text: c.data.text, at: c.createdAt })),
    commentsShown: comments.length,
    commentCount: card.commentCount,
  };
}
