/**
 * One line per tool call: the tool, what it acted on, whether it worked. The
 * tool's output is never kept (PRD glossary). Written by `sessions.ingest` and
 * immutable afterwards (Table Contract).
 */
export interface ToolNote {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `harnessMessageId` and `ordinal`. */
  sessionId: string;
  harnessMessageId: string;
  /** Position among the calls of that message, chosen by the parser (AD-4). */
  ordinal: number;
  tool: string;
  /** What the call acted on, e.g. a file path. Searched by keyword (AD-15). */
  target: string;
  ok: boolean;
}
