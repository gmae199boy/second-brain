#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
const exported = await readFile('export.json', 'utf8');
await appendFile(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, env: process.env, pid: process.pid, pgid, exported }) + '\n');
const output = process.env.FAKE_CODEX_MODE === 'invalid' ? { status: 'ok' } : { status: 'ok', summary: 'synthetic', report_md: '# Synthetic report\n', judgments: [], evidence: [], next_checks: [] };
await writeFile(args[args.indexOf('-o') + 1], JSON.stringify(output));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } }));
