import { maskOutputText, toolNoteForOutput } from '../output/mask.js';
/** Mask string keys and values, applying the tool-note rule to session-shaped input. */
export function encodeAnalysisExport(value: unknown): string {
  function mask(input: unknown): unknown {
    if (typeof input === 'string') return maskOutputText(input);
    if (Array.isArray(input)) return input.map(mask);
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const notes = record['toolNotes'];
      const prepared = Array.isArray(notes) ? { ...record, toolNotes: notes.map(note => note !== null && typeof note === 'object' && typeof note.target === 'string' ? toolNoteForOutput(note) : note) } : record;
      return Object.fromEntries(Object.entries(prepared).map(([key, item]) => [maskOutputText(key), mask(item)]));
    }
    return input;
  }
  return JSON.stringify(mask(value));
}
