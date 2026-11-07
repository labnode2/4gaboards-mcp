/** Subset of the 4ga Boards payloads this server relies on (see docs/API_NOTES.md). Ids are numeric strings. */
export interface Project { id: string; name: string }
export interface BoardSummary {
  id: string; projectId: string; name: string; position: number;
  cardTotal?: number; cardCompleted?: number; taskTotal?: number; taskCompleted?: number;
}
export interface List { id: string; boardId: string; name: string; position: number; isCompleted: boolean; isCollapsed?: boolean }
export interface Label { id: string; boardId: string; name: string | null; color: string }
export interface Card {
  id: string; boardId: string; listId: string; name: string; description: string | null; position: number;
  isCompleted: boolean; dueDate: string | null; commentCount: number; createdAt: string | null; updatedAt: string | null;
}
export interface Task { id: string; cardId: string; name: string; position: number; isCompleted: boolean; dueDate?: string | null }
export interface CardLabel { id: string; cardId: string; labelId: string }
export interface Comment { id: string; cardId: string; userId: string; data: { text: string; userName?: string }; createdAt: string | null }

export interface BoardSnapshot {
  board: BoardSummary;
  lists: List[];
  labels: Label[];
  cards: Card[];
  tasks: Task[];
  cardLabels: CardLabel[];
}
