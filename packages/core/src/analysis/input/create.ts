import type { AnalysisInputStore } from '../../ports/analysis.js';
import type { FileStore } from '../../ports/file-store.js';
import type { IdGen } from '../../ports/id-gen.js';
import { contentHashOfBytes } from '../../domain/file.js';
import { selectDayPrevious } from './predecessors.js';
import { buildInputSnapshot, encodeInputSnapshot } from './snapshot.js';

const invalid = (message: string) => ({ok:false as const,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID' as const,message});
export async function createAnalysisInputSnapshot(deps: {store: AnalysisInputStore; files: FileStore; idGen: IdGen; now: () => Date; labels: Uint8Array; readProfile: (path: string) => Promise<Uint8Array | null>}, input: {collectWorkId:string; artifactsWorkId:string; bundleId:string}) {
  if (![input.collectWorkId,input.artifactsWorkId].every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return invalid('일감 ID가 올바르지 않습니다');
  const existing = await deps.store.findAnalysisSnapshotByInputs(input.collectWorkId,input.artifactsWorkId);
  if (!existing.ok || existing.snapshot) return existing;
  const read = await deps.store.readAnalysisInputSources(input.collectWorkId,input.artifactsWorkId);
  if (!read.ok) return read;
  const digest = await deps.files.get(read.sources.digest.location);
  if (!digest.ok) return digest;
  const yesterday = new Date(Date.parse(`${read.sources.reportDate}T00:00:00Z`) - 86400000).toISOString().slice(0,10);
  const previous = selectDayPrevious(read.sources.analyses,yesterday,'day');
  let previousReport: Uint8Array | undefined;
  if (previous?.source === 'legacy' && previous.reportMd !== null && previous.reportMd !== undefined) previousReport = new TextEncoder().encode(previous.reportMd);
  else if (previous?.reportLocation) { const file = await deps.files.get(previous.reportLocation); if (!file.ok) return file; previousReport = file.bytes; }
  let profile: Uint8Array | null = null; try { if (read.sources.profilePath) profile = await deps.readProfile(read.sources.profilePath); } catch { /* legacy reader records a note */ }
  const snapshotId = deps.idGen.next();
  if (profile) { try { new TextDecoder('utf-8',{fatal:true}).decode(profile); } catch { profile = null; } }
  const content = encodeInputSnapshot(buildInputSnapshot(read.sources,{snapshotId,digest:digest.bytes,labels:deps.labels,...(profile ? {profile}:{}),...(previousReport ? {previousReport}:{})}));
  const snapshot = {id:snapshotId,bundleId:input.bundleId,localDate:read.sources.reportDate,timeZone:read.sources.timeZone,content,contentSha256:contentHashOfBytes(content).slice(7),createdAt:deps.now()};
  return deps.store.createInputSnapshot(snapshot,input.collectWorkId,input.artifactsWorkId);
}
