import { describe, expect, it } from 'vitest';
import { explicitPathParsers, harnesses, harnessParsers, transcriptFolders, watchFolders } from '../src/harnesses.js';

describe('explicit path parser registration', () => {
  it('registers Codex alongside Claude without a Codex connector, folder, or watcher', () => {
    expect([...harnessParsers(), ...explicitPathParsers()].map(parser => parser.harness)).toEqual(['claude-code', 'codex']);
    expect(harnesses.map(harness => harness.parser.harness)).toEqual(['claude-code']);
    expect(transcriptFolders({ CLAUDE_CONFIG_DIR: '/synthetic/claude' }).map(folder => folder.harness)).toEqual(['claude-code']);
    expect(watchFolders({ CLAUDE_CONFIG_DIR: '/synthetic/claude' })).toEqual(['/synthetic/claude/projects']);
  });
});

import { codexParser } from '../../../packages/codex/src/index.js';
import { memoryTranscriptReader } from '../../../packages/core/src/testing/fakes/transcript.js';
import { fixedClock } from '../../../packages/core/src/testing/fakes/clock.js';
import { sessionsIngestCommand } from '../src/commands/sessions-ingest.js';
import type { SpoolCommandContext } from '../src/dispatch.js';

describe('explicit Codex ingest schema guard', () => {
  const path = '/synthetic/session.jsonl';
  const content = JSON.stringify({ type: 'session_meta', payload: { id: 'file-id', session_id: 'shared-parent' } }) + '\n';
  const clock = fixedClock(new Date('2026-01-01T00:00:00Z'));
  const cases = ['DB_UNAVAILABLE', 'DB_LOCKED', 'SCHEMA_MISMATCH'] as const;
  it.each(cases)('rejects mismatch before any spool on %s', async cause => {
    const transcripts = memoryTranscriptReader({ files: { [path]: content } });
    let spools = 0, arrivals = 0;
    const context: SpoolCommandContext = { clock, options: {}, args: ['codex'], stdin: async () => JSON.stringify({ id: 'wrong', transcript_path: path }), recordHookArrival: async () => { arrivals++; }, cause, message: 'synthetic', spoolIngest: async () => { spools++; throw new Error('unexpected spool'); } };
    const result = await sessionsIngestCommand(harnesses, [codexParser()], transcripts).spool!(context);
    expect(result).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    expect(spools).toBe(0);
    expect(arrivals).toBe(0);
  });
  it.each(cases)('spools a validated explicit file on %s', async cause => {
    const transcripts = memoryTranscriptReader({ files: { [path]: content } });
    const inputs: unknown[] = [];
    const context: SpoolCommandContext = { clock, options: {}, args: ['codex'], stdin: async () => JSON.stringify({ id: 'file-id', transcript_path: path }), recordHookArrival: async () => { throw new Error('unexpected hook arrival'); }, cause, message: 'synthetic', spoolIngest: async input => { inputs.push(input); return { ok: true, session: input.session, spooled: true, created: false, inserted: { messages: 0, toolNotes: 0 }, droppedLines: null, warnings: ['SPOOLED'] }; } };
    const result = await sessionsIngestCommand(harnesses, [codexParser()], transcripts).spool!(context);
    expect(result).toMatchObject({ ok: true, data: { spooled: true } });
    expect(inputs).toEqual([{ session: 'codex:file-id', transcriptPath: path }]);
  });
  it('retains Claude spool without transcript pre-reading', async () => {
    const transcripts = memoryTranscriptReader();
    let arrivals = 0;
    const context: SpoolCommandContext = { clock, options: {}, args: ['claude-code'], stdin: async () => JSON.stringify({ session_id: 'synthetic-claude', transcript_path: path }), recordHookArrival: async () => { arrivals++; }, cause: 'DB_UNAVAILABLE', message: 'synthetic', spoolIngest: async input => ({ ok: true, session: input.session, spooled: true, created: false, inserted: { messages: 0, toolNotes: 0 }, droppedLines: null, warnings: ['SPOOLED'] }) };
    expect(await sessionsIngestCommand(harnesses, [codexParser()], transcripts).spool!(context)).toMatchObject({ ok: true, data: { spooled: true } });
    expect(transcripts.reads()).toEqual([]);
    expect(arrivals).toBe(1);
  });
  it('requires explicit file id and path instead of accepting a shared session_id', async () => {
    const context: SpoolCommandContext = { clock, options: {}, args: ['codex'], stdin: async () => JSON.stringify({ session_id: 'shared-parent', transcript_path: path }), recordHookArrival: async () => {}, cause: 'DB_UNAVAILABLE', message: 'synthetic', spoolIngest: async () => { throw new Error('unexpected spool'); } };
    expect(await sessionsIngestCommand(harnesses, [codexParser()], memoryTranscriptReader({ files: { [path]: content } })).spool!(context)).toMatchObject({ ok: false, code: 'USAGE' });
  });
});
