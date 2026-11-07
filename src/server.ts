import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBoardTools } from './tools/boards.js';
import { registerCardTools } from './tools/cards.js';
import { registerCommentTools } from './tools/comments.js';
import { registerLabelTools } from './tools/labels.js';
import type { Ctx } from './tools/shared.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerWorkflowTools } from './tools/workflow.js';

export const VERSION = '0.1.0';

export function createServer(ctx: Ctx): McpServer {
  const focus = ctx.focusBoardId ? ` Focus mode: restricted to board ${ctx.focusBoardId}.` : '';
  const server = new McpServer(
    { name: '4gaboards', version: VERSION },
    {
      instructions:
        'Tools for the 4ga Boards kanban app. Ids are numeric strings. Start with list_projects / get_board to discover list and label ids, then read and update cards.' +
        (ctx.allowDelete ? ' Deletion tools are enabled; use them only on explicit request.' : ' Deletion is disabled.') +
        focus,
    },
  );
  registerBoardTools(server, ctx);
  registerCardTools(server, ctx);
  registerCommentTools(server, ctx);
  registerTaskTools(server, ctx);
  registerLabelTools(server, ctx);
  registerWorkflowTools(server, ctx);
  return server;
}
