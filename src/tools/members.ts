import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITE, defineTool, idSchema, loadCard, memberView, resolveMember, type Ctx } from './shared.js';

export function registerMemberTools(server: McpServer, ctx: Ctx): void {
  const userArg = z.string().trim().min(1).describe('Board member: user id (numeric), username or exact display name; see get_board for the board\'s members');

  defineTool(
    server,
    'add_card_member',
    'Assign member to card',
    'Assign a board member to a card. Only users who are members of the card\'s board can be assigned. Fails with a conflict if already assigned. Needs an editor role.',
    { card_id: idSchema('Card id'), user: userArg },
    WRITE,
    async ({ card_id, user }) => {
      const card = await loadCard(ctx, card_id);
      const u = resolveMember(await ctx.client.getBoard(card.boardId), user);
      await ctx.client.addCardMember(card_id, u.id);
      return { cardId: card_id, member: memberView(u) };
    },
  );

  defineTool(
    server,
    'remove_card_member',
    'Unassign member from card',
    'Remove a member from a card (they stay on the board). Needs an editor role.',
    { card_id: idSchema('Card id'), user: userArg },
    { ...WRITE, idempotentHint: true },
    async ({ card_id, user }) => {
      const card = await loadCard(ctx, card_id);
      const u = resolveMember(await ctx.client.getBoard(card.boardId), user);
      await ctx.client.removeCardMember(card_id, u.id);
      return { cardId: card_id, removed: memberView(u) };
    },
  );
}
