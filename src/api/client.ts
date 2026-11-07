import type { Config } from '../config.js';
import { Authenticator, type FetchLike } from './auth.js';
import { ApiError } from './errors.js';
import { Http } from './http.js';
import type { BoardSnapshot, BoardSummary, Card, CardLabel, Comment, Project, Task } from './types.js';

interface Item<T> { item: T }
interface Items<T, I = unknown> { items: T[]; included?: I }

export interface ClientOptions {
  fetchFn?: FetchLike;
  retryDelayMs?: number;
}

export class FourgaClient {
  private readonly http: Http;

  constructor(
    cfg: Pick<Config, 'baseUrl' | 'credentials' | 'allowDelete' | 'timeoutMs'>,
    opts: ClientOptions = {},
  ) {
    const fetchFn = opts.fetchFn ?? fetch;
    const auth = new Authenticator(cfg.baseUrl, cfg.credentials, fetchFn, cfg.timeoutMs);
    this.http = new Http({ baseUrl: cfg.baseUrl, auth, fetchFn, timeoutMs: cfg.timeoutMs, retryDelayMs: opts.retryDelayMs });
    this.allowDelete = cfg.allowDelete;
  }

  private readonly allowDelete: boolean;

  private assertDelete(): void {
    if (!this.allowDelete) throw new ApiError('Deleting is disabled (set FOURGA_ALLOW_DELETE=true to enable).', 403);
  }

  async listProjects(): Promise<{ projects: Project[]; boards: BoardSummary[] }> {
    const r = await this.http.request<Items<Project, { boards?: BoardSummary[] }>>('GET', '/projects');
    return { projects: r.items, boards: r.included?.boards ?? [] };
  }

  async getBoard(boardId: string): Promise<BoardSnapshot> {
    const r = await this.http.request<
      Item<BoardSummary> & {
        included?: { lists?: BoardSnapshot['lists']; labels?: BoardSnapshot['labels']; cards?: Card[]; tasks?: Task[]; cardLabels?: CardLabel[] };
      }
    >('GET', `/boards/${boardId}`, { hint: 'Check the board id with list_boards.' });
    const inc = r.included ?? {};
    return {
      board: r.item,
      lists: [...(inc.lists ?? [])].sort((a, b) => a.position - b.position),
      labels: inc.labels ?? [],
      cards: inc.cards ?? [],
      tasks: inc.tasks ?? [],
      cardLabels: inc.cardLabels ?? [],
    };
  }

  async getCard(cardId: string): Promise<{ card: Card; tasks: Task[]; cardLabels: CardLabel[] }> {
    const r = await this.http.request<Item<Card> & { included?: { tasks?: Task[]; cardLabels?: CardLabel[] } }>(
      'GET',
      `/cards/${cardId}`,
      { hint: 'Check the card id with get_board / list_cards.' },
    );
    return { card: r.item, tasks: r.included?.tasks ?? [], cardLabels: r.included?.cardLabels ?? [] };
  }

  /** Newest first; pass `beforeId` of the last item for the next (older) page. */
  async listComments(cardId: string, beforeId?: string): Promise<Comment[]> {
    const r = await this.http.request<Items<Comment>>('GET', `/cards/${cardId}/comments`, {
      query: beforeId ? { beforeId } : undefined,
      hint: 'Check the card id.',
    });
    return r.items;
  }

  async createCard(listId: string, input: { name: string; description?: string; position?: number; dueDate?: string }): Promise<Card> {
    const r = await this.http.request<Item<Card>>('POST', `/lists/${listId}/cards`, { body: input, hint: 'Check the list id with get_board.' });
    return r.item;
  }

  async updateCard(
    cardId: string,
    input: { name?: string; description?: string | null; dueDate?: string | null; listId?: string; position?: number },
  ): Promise<Card> {
    const r = await this.http.request<Item<Card>>('PATCH', `/cards/${cardId}`, { body: input, hint: 'Check the card id (and list id when moving).' });
    return r.item;
  }

  async deleteCard(cardId: string): Promise<void> {
    this.assertDelete();
    await this.http.request('DELETE', `/cards/${cardId}`, { hint: 'Check the card id.' });
  }

  async createComment(cardId: string, text: string): Promise<Comment> {
    const r = await this.http.request<Item<Comment>>('POST', `/cards/${cardId}/comments`, { body: { text }, hint: 'Check the card id.' });
    return r.item;
  }

  async deleteComment(commentId: string): Promise<void> {
    this.assertDelete();
    await this.http.request('DELETE', `/comments/${commentId}`, { hint: 'Check the comment id.' });
  }

  async createTask(cardId: string, name: string): Promise<Task> {
    const r = await this.http.request<Item<Task>>('POST', `/cards/${cardId}/tasks`, { body: { name }, hint: 'Check the card id.' });
    return r.item;
  }

  async updateTask(taskId: string, input: { isCompleted?: boolean; name?: string }): Promise<Task> {
    const r = await this.http.request<Item<Task>>('PATCH', `/tasks/${taskId}`, { body: input, hint: 'Check the task id (see get_card).' });
    return r.item;
  }

  async addCardLabel(cardId: string, labelId: string): Promise<CardLabel> {
    const r = await this.http.request<Item<CardLabel>>('POST', `/cards/${cardId}/labels`, { body: { labelId }, hint: 'Check card and label ids.' });
    return r.item;
  }

  async removeCardLabel(cardId: string, labelId: string): Promise<void> {
    await this.http.request('DELETE', `/cards/${cardId}/labels/${labelId}`, { hint: 'The label may not be on this card.' });
  }
}
