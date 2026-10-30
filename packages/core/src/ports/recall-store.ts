export interface RecallSource {
  kind: 'conversation'; session: string; harness: string; started_at: string; workspace_id: string | null; tag_source: string | null; project_id: string | null; worktree_id: string | null;
  from_at: string | null; to_at: string | null;
}
export interface RecallRow extends RecallSource {
  chunk_id?: string; tool_note_id?: string; message_id?: string | null; tool?: string; body: string;
}
export interface RecallStore {
  searchRecall(input: { kind: 'chunks' | 'tools'; query: string; pattern: string; limit: number; worktree?: string; project?: string }): Promise<{ ok: true; rows: RecallRow[] } | { ok: false; code: 'DB_UNAVAILABLE' | 'SEARCH_FAILED'; message: string }>;
}
