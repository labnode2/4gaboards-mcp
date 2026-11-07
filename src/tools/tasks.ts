import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError } from '../api/errors.js';
import { WRITE, defineTool, idSchema, loadCard, type Ctx } from './shared.js';

export function registerTaskTools(server: McpServer, ctx: Ctx): void {
  defineTool(
    server,
    'create_task',
    'Create task',
    'Add a task (checklist item) at the end of a card\'s task list.',
    { card_id: idSchema('Card id'), name: z.string().trim().min(1).max(1024) },
    WRITE,
    async ({ card_id, name }) => {
      await loadCard(ctx, card_id);
      const t = await ctx.client.createTask(card_id, name);
      return { id: t.id, name: t.name, done: t.isCompleted, cardId: t.cardId };
    },
  );

  defineTool(
    server,
    'toggle_task',
    'Set task done state',
    'Mark a task (checklist item) done or not done. Task ids are listed by get_card.',
    { task_id: idSchema('Task id'), done: z.boolean().describe('true = completed, false = open') },
    { ...WRITE, idempotentHint: true },
    async ({ task_id, done }) => {
      if (ctx.focusBoardId) {
        const s = await ctx.client.getBoard(ctx.focusBoardId);
        if (!s.tasks.some((t) => t.id === task_id)) {
          throw new UserError(`Task ${task_id} was not found on the focus board ${ctx.focusBoardId}.`);
        }
      }
      const t = await ctx.client.updateTask(task_id, { isCompleted: done });
      return { id: t.id, name: t.name, done: t.isCompleted };
    },
  );
}
