#!/usr/bin/env node
import { preflight } from './policy.mjs';
if (process.argv.length !== 3) {
  console.error('사용법: node tooling/protected-deployment/preflight.mjs <staging 경로>');
  process.exitCode = 2;
} else {
  const result = preflight(process.argv[2]);
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
}
