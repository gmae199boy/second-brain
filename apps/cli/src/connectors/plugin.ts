import type { Connector, ConnectResult } from 'second_brain';
import { readInstalled, readPluginRun } from '../install/installed.js';

export async function installedPluginRoot(home: string, readRecord = readInstalled): Promise<string | null> {
  const seen = await readPluginRun(home);
  if (seen.status === 'ok') return seen.record.plugin_root;
  return (await readRecord(home))?.plugin_root ?? null;
}

export function connectionLines(
  connector: Connector,
  result: Extract<ConnectResult, { ok: true }>,
  root: string | null,
): string[] {
  if (connector.hookSource === 'settings') return [result.changed
    ? `${result.target}에 ${connector.label}를 연결했습니다`
    : `${result.target}에 ${connector.label}가 이미 연결되어 있습니다`];
  return [
    ...(result.changed ? [`${result.target}에서 예전 brain hook을 지웠습니다`] : []),
    root === null
      ? `${connector.label} 플러그인이 설치되어 있지 않습니다. Claude Code에서 second-brain 플러그인을 설치하세요`
      : `${connector.label}는 ${root}의 플러그인으로 연결되어 있습니다`,
  ];
}
