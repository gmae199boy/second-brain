import { checkExtensionExecution } from './replacement.js';
import { decodeExtensionManifest, isExtensionName } from './manifest.js';
import type { ExtensionDependencies } from './install.js';

export async function runExtension(deps: ExtensionDependencies, input: { name: string; job: string; target?: string; waitMs?: number }) {
  const invalid = () => ({ ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 일감 선언이나 요청이 올바르지 않습니다' });
  // [ASSUMPTION] 대상 식별자는 최대 64자의 제한된 ASCII 문자를 사용한다.
  if (!isExtensionName(input.name) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.job) || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(input.target ?? 'default')) return invalid();
  const runtime = deps.extensions;
  if (!runtime?.installedManifest || !deps.store.enqueueExtensionWork) return invalid();
  const enqueue = async () => {
    const allowed = await checkExtensionExecution(deps.store, input.name); if (!allowed.ok) return allowed;
    const installed = await deps.store.getExtension(input.name);
    if (!installed.ok) return installed;
    if (!installed.extension) return { ok: false as const, code: 'EXTENSION_NOT_FOUND' as const, message: '설치된 확장이 없습니다' };
    let text: string; try { text = await runtime.installedManifest!(input.name); } catch { return invalid(); }
    const decoded = decodeExtensionManifest(text, runtime.validateSchema);
    if (!decoded.ok || decoded.manifest.name !== input.name || decoded.manifest.version !== installed.extension.version) return invalid();
    const job = decoded.manifest.work?.find(w => w.manual === input.job);
    if (!job) return invalid();
    const now = deps.clock.now();
    const result = await deps.store.enqueueExtensionWork({ name: input.name, version: decoded.manifest.version, work: { id: deps.idGen.next(), kind: job.kind, targetKind: 'extension', targetId: input.target ?? 'default', createdAt: now, nextAttemptAt: now } });
    if (!result.ok) return result;
    if (result.state !== 'queued') return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장이 비활성 상태이거나 설치 상태가 변경되었습니다' };
    return { ok: true as const, result, report: job.public_report };
  };
  let queued: Awaited<ReturnType<typeof enqueue>>;
  try { queued = runtime.withInstallLock ? await runtime.withInstallLock(input.name, enqueue) : await enqueue(); }
  catch { return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '확장 설치 잠금을 확보하지 못했습니다' }; }
  if (!queued.ok) return queued;
  const base = { ok: true as const, workId: queued.result.workId, created: queued.result.created, status: 'queued' as const };
  if (!queued.report || !runtime.readPublicReport || !deps.store.getWork) return base;
  // [ASSUMPTION] 보고 일감만 최대 30초 기다린다.
  const budget = Number.isFinite(input.waitMs ?? 30_000) ? Math.max(0, Math.min(30_000, input.waitMs ?? 30_000)) : 0;
  const deadline = deps.clock.now().getTime() + budget;
  do {
    const state = await deps.store.getWork(base.workId);
    if (!state.ok) return state;
    if (state.entry?.item.completedAt) {
      const failed = state.entry.item.outcome !== 'succeeded';
      if (failed && state.entry.latestAttempt?.errorCode !== 'EXTENSION_REPORT_NOT_READY') return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 일감이 실패했습니다' };
      let value: unknown; try { value = await runtime.readPublicReport(input.name, base.workId); } catch { return invalid(); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
      const report = value as Record<string, unknown>;
      const validSection = (section: unknown, labels: string[], count: boolean) => !!section && typeof section === 'object' && !Array.isArray(section) && Object.keys(section).length === labels.length && labels.every(label => Object.hasOwn(section, label) && (count ? Number.isSafeInteger((section as Record<string, unknown>)[label]) && ((section as Record<string, number>)[label] ?? -1) >= 0 : typeof (section as Record<string, unknown>)[label] === 'boolean'));
      if (Object.keys(report).length !== 2 || !validSection(report['counts'], queued.report.counts, true) || !validSection(report['checks'], queued.report.checks, false)) return invalid();
      const safeReport = report as { counts: Record<string, number>; checks: Record<string, boolean> };
      if (failed) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 일감이 준비되지 않았습니다', workId: base.workId, report: safeReport };
      return { ...base, status: 'completed' as const, report: safeReport };
    }
    if (deps.clock.now().getTime() >= deadline) break;
    await runtime.timer.sleep(Math.min(100, deadline - deps.clock.now().getTime()), new AbortController().signal);
  } while (true);
  return base;
}
