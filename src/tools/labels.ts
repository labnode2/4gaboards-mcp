import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITE, defineTool, idSchema, loadCard, resolveLabel, type Ctx } from './shared.js';

export function registerLabelTools(server: McpServer, ctx: Ctx): void {
  const labelArg = z.string().trim().min(1).describe('Label id (numeric) or exact label name; see get_board for the board\'s labels');

  defineTool(
    server,
    'add_label',
    'Add label to card',
    'Attach an existing board label to a card. Fails with a conflict if it is already attached. Creating new labels is not supported.',
    { card_id: idSchema('Card id'), label: labelArg },
    WRITE,
    async ({ card_id, label }) => {
      const card = await loadCard(ctx, card_id);
      const l = resolveLabel(await ctx.client.getBoard(card.boardId), label);
      await ctx.client.addCardLabel(card_id, l.id);
      return { cardId: card_id, label: { id: l.id, name: l.name, color: l.color } };
    },
  );

  defineTool(
    server,
    'remove_label',
    'Remove label from card',
    'Detach a label from a card (the label itself is kept on the board).',
    { card_id: idSchema('Card id'), label: labelArg },
    { ...WRITE, idempotentHint: true },
    async ({ card_id, label }) => {
      const card = await loadCard(ctx, card_id);
      const l = resolveLabel(await ctx.client.getBoard(card.boardId), label);
      await ctx.client.removeCardLabel(card_id, l.id);
      return { cardId: card_id, removed: { id: l.id, name: l.name } };
    },
  );
}
