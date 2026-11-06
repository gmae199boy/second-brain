import { decodeChunkLocator, type ChunkLocator } from '../domain/chunk-locator.js';
import { maskSecrets } from '../domain/secret-patterns.js';
import type { DocumentPiece } from '../ports/document-recall-store.js';

type Positioned = { piece: DocumentPiece; locator: ChunkLocator; start: number; end: number; trim: number; group: number };
/** Reconstruct only overlapping text; a newline separates gaps and non-text locations. */
export function documentContext(pieces: readonly DocumentPiece[]) {
  const points: string[] = []; const positioned: Positioned[] = [];
  let groupId = 0;
  let group: { docStart: number; docEnd: number; globalStart: number } | undefined;
  for (const piece of [...pieces].sort((a,b) => a.ordinal-b.ordinal)) {
    const decoded = decodeChunkLocator(piece.chunk_locator);
    if (!decoded.ok) return null;
    const loc = decoded.locator, body = Array.from(piece.body);
    if (loc.type === 'text') {
      if (body.length !== loc.end - loc.start) return null;
      if (!group || loc.start > group.docEnd || loc.start < group.docStart) {
        if (points.length) points.push('\n');
        groupId++;
        group = { docStart:loc.start, docEnd:loc.start, globalStart:points.length };
      }
      const start = group.globalStart + loc.start - group.docStart;
      const trim = Math.min(body.length, Math.max(0, group.docEnd - loc.start));
      for (let i = 0; i < trim; i++) if (points[start + i] !== body[i]) return null;
      for (let i = trim; i < body.length; i++) points.push(body[i]!);
      group.docEnd = Math.max(group.docEnd, loc.end);
      positioned.push({piece,locator:loc,start,end:start+body.length,trim,group:groupId});
    } else {
      group = undefined;
      if (points.length) points.push('\n');
      const start = points.length; for (const char of body) points.push(char);
      positioned.push({piece,locator:loc,start,end:points.length,trim:0,group:++groupId});
    }
  }
  const text = points.join('');
  const spans = maskSecrets(text, 'body').spans;
  function project(start: number, end: number, emitted?: Set<number>) {
    let at = start; const out: string[] = [];
    for (const [index, span] of spans.entries()) {
      if (span.end <= start || span.start >= end) continue;
      const left = Math.max(start, span.start), right = Math.min(end, span.end);
      out.push(points.slice(at,left).join(''));
      if (!emitted?.has(index)) out.push(`[REDACTED:${span.kind}]`);
      emitted?.add(index); at = right;
    }
    out.push(points.slice(at,end).join('')); return out.join('');
  }
  return { text, positioned, project };
}
