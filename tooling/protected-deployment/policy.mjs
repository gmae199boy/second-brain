// 이 정책은 설치 후보를 기술하며 권한 상승이나 서비스 설치를 수행하지 않는다.
import { lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

export const policy = Object.freeze({
  format: 1,
  engine: 'orbstack',
  principals: ['supervisor', 'broker', 'garmin-worker'],
  paths: ['package', 'config', 'credentials', 'socket', 'backup'],
  rootOwner: 0,
  authInput: false,
  externalHttp: false,
});
const digest = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export function render(root) {
  const contents = json(policy);
  writeFileSync(join(root, 'policy.json'), contents, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(root, 'package-manifest.json'), json({ format: 1, files: { 'policy.json': digest(contents) } }), { mode: 0o600, flag: 'wx' });
}

// 실제 root 소유권 검사와 합성 fixture는 호출자가 명시적으로 구분한다.
export function inspectDirectory(path, owner) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === owner && (stat.mode & 0o022) === 0;
  } catch { return false; }
}

export function preflight(root) {
  const failures = [];
  if (!inspectDirectory(root, 0)) failures.push('ROOT_OWNERSHIP');
  try {
    const manifestStat = lstatSync(join(root, 'package-manifest.json'));
    const policyStat = lstatSync(join(root, 'policy.json'));
    if (![manifestStat, policyStat].every(st => st.isFile() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0)) failures.push('PACKAGE_OWNERSHIP');
    const manifest = JSON.parse(readFileSync(join(root, 'package-manifest.json'), 'utf8'));
    const contents = readFileSync(join(root, 'policy.json'), 'utf8');
    if (JSON.stringify(manifest) !== JSON.stringify({ format: 1, files: { 'policy.json': digest(contents) } }) || contents !== json(policy)) failures.push('PACKAGE_MISMATCH');
  } catch { failures.push('PACKAGE_UNREADABLE'); }
  // 사용자 파일의 주장이나 같은 UID fixture는 엔진 격리 증거가 아니다.
  failures.push('ENGINE_ISOLATION_UNVERIFIED', 'SERVICE_IDENTITY_UNVERIFIED', 'SIGNATURE_UNVERIFIED');
  return { ready: false, authInput: false, externalHttp: false, failures };
}

// 새로 만든 staging의 알려진 파일만 제거한다. 낯선 파일은 보존한다.
export function rollback(root) {
  if (!/^brain-protected-stage-[A-Za-z0-9]{6}$/.test(basename(root))) throw new Error('NOT_STAGE');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0) throw new Error('NOT_STAGE');
  const allowed = new Set(['README.md', 'engine-assessment.json', 'policy.json', 'package-manifest.json', 'evidence']);
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some(e => !allowed.has(e.name) || e.isSymbolicLink() || (e.name === 'evidence' ? !e.isDirectory() : !e.isFile()))) throw new Error('STAGE_CHANGED');
  if (readdirSync(join(root, 'evidence')).length) throw new Error('EVIDENCE_NOT_EMPTY');
  for (const entry of entries) {
    if (entry.name === 'evidence') rmdirSync(join(root, entry.name));
    else rmSync(join(root, entry.name));
  }
  rmdirSync(root);
}
