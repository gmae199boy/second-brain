import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

for (const script of ['check_collect_notice.py', 'check_body.py', 'check_artifact_inputs.py', 'check_body_runtime.py', 'check_artifact_failure.py', 'check_digest_equivalence.py', 'check_charts.py', 'check_chart_fonts.py']) {
  it(`runs ${script} in the regular Python suite`, () => {
    const python = fileURLToPath(new URL('../../../extensions/garmin/.venv/bin/python', import.meta.url));
    const test = fileURLToPath(new URL(`../../../extensions/garmin/tests/${script}`, import.meta.url));
    execFileSync(python, ['-B', test], { stdio: 'pipe' });
  }, 120_000);
}
