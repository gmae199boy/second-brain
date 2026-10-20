/**
 * The first line of a tool note's target, cut to this many UTF-16 units by the
 * connector's parser before Core ever sees it.
 *
 * It lives here rather than in the connector because the cut is what makes the
 * truncated-tail rule necessary: a key that straddles the limit is stored as
 * the harmless-looking first half of itself, and the output masking has to
 * know where that half can only have come from (`output/mask.ts`, AD-11).
 */
export const TOOL_NOTE_TARGET_LIMIT = 500;

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
