import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ, cardSummary, defineTool, idSchema, resolveBoardId, type Ctx } from './shared.js';

export function registerBoardTools(server: McpServer, ctx: Ctx): void {
  const visible = async () => {
    const { projects, boards } = await ctx.client.listProjects();
    const bs = ctx.focusBoardId ? boards.filter((b) => b.id === ctx.focusBoardId) : boards;
    const pids = new Set(bs.map((b) => b.projectId));
    return { projects: projects.filter((p) => pids.has(p.id) || (!ctx.focusBoardId && bs.length === 0)), boards: bs };
  };

  defineTool(
    server,
    'list_projects',
    'List projects',
    'List the 4ga Boards projects the account can see, with their boards (id, name, card/task counts). Start here to discover ids. In focus mode only the focus board\'s project is returned.',
    {},
    READ,
    async () => {
      const { projects, boards } = await visible();
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        boards: boards.filter((b) => b.projectId === p.id).map((b) => ({ id: b.id, name: b.name })),
      }));
    },
  );

  defineTool(
    server,
    'list_boards',
    'List boards',
    'List boards the account can access, optionally only those of one project. Returns id, name, projectId and card/task completion counts.',
    { project_id: idSchema('Project id').optional() },
    READ,
    async ({ project_id }) => {
      const { boards } = await visible();
      return boards
        .filter((b) => !project_id || b.projectId === project_id)
        .sort((a, b) => a.position - b.position)
        .map((b) => ({
          id: b.id,
          name: b.name,
          projectId: b.projectId,
          cards: b.cardTotal === undefined ? undefined : `${b.cardCompleted ?? 0}/${b.cardTotal} done`,
          tasks: b.taskTotal === undefined ? undefined : `${b.taskCompleted ?? 0}/${b.taskTotal} done`,
        }));
    },
  );

  defineTool(
    server,
    'get_board',
    'Get board overview',
    'Get one board: its lists (id, name, isCompleted), labels (id, name, color) and a compact summary of the cards in each list (no descriptions; use get_card for those). Lists and labels ids returned here are what other tools need. Cards are ordered top-to-bottom as on the board.',
    {
      board_id: idSchema('Board id').optional().describe('Board id; optional in focus mode'),
      include_cards: z.boolean().default(true).describe('Set false to get only lists and labels'),
      max_cards_per_list: z.number().int().min(1).max(500).default(100).describe('Cap on cards listed per list'),
    },
    READ,
    async ({ board_id, include_cards, max_cards_per_list }) => {
      const id = resolveBoardId(ctx, board_id) as string;
      const s = await ctx.client.getBoard(id);
      return {
        id: s.board.id,
        name: s.board.name,
        projectId: s.board.projectId,
        labels: s.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
        lists: s.lists.map((l) => {
          const cards = s.cards.filter((c) => c.listId === l.id).sort((a, b) => a.position - b.position);
          return {
            id: l.id,
            name: l.name,
            isCompleted: l.isCompleted || undefined,
            cardCount: cards.length,
            cards: include_cards ? cards.slice(0, max_cards_per_list).map((c) => cardSummary(s, c)) : undefined,
            truncated: include_cards && cards.length > max_cards_per_list ? true : undefined,
          };
        }),
      };
    },
  );
}

