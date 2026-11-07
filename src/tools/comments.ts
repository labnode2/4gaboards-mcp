import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError } from '../api/errors.js';
import { DESTRUCTIVE, WRITE, defineTool, idSchema, loadCard, type Ctx } from './shared.js';

export function registerCommentTools(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    'add_comment',
    'Add comment',
    'Add a comment (Markdown) to a card as the configured account. Needs editor role, or viewer role with comment permission.',
    { card_id: idSchema('Card id'), text: z.string().trim().min(1).max(20000) },
    WRITE,
    async ({ card_id, text }) => {
      await loadCard(ctx, card_id);
      const c = await ctx.client.createComment(card_id, text);
      return { id: c.id, cardId: c.cardId, at: c.createdAt };
    },
  );

  if (ctx.allowDelete) {
    defineTool(
      server,
      'delete_comment',
      'Delete comment',
      'Delete a comment. Needs the card id too, to verify the comment really belongs to that card before deleting. Only use when the user explicitly asked.',
      { card_id: idSchema('Card id'), comment_id: idSchema('Comment id') },
      DESTRUCTIVE,
      async ({ card_id, comment_id }) => {
        await loadCard(ctx, card_id);
        let before: string | undefined;
        let found = false;
        for (let page = 0; page < 20 && !found; page++) {
          const items = await ctx.client.listComments(card_id, before);
          if (items.length === 0) break;
          found = items.some((c) => c.id === comment_id);
          before = items[items.length - 1]?.id;
        }
        if (!found) throw new UserError(`Comment ${comment_id} was not found on card ${card_id}; nothing deleted.`);
        await ctx.client.deleteComment(comment_id);
        return { deleted: true, id: comment_id };
      },
    );
  }
}
