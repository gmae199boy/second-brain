#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, compare, sanitize } from './src/core.mjs';
import { run } from './src/import-cleanup.mjs';
import { run as runSnapshot } from './src/session-snapshot.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function main(args = process.argv.slice(2)) {
try {
 const opts=parseArgs(args);
 if (opts.command==='compare') { const result=compare(JSON.parse(await readFile(opts.base,'utf8')),JSON.parse(await readFile(opts.change,'utf8'))); console.log(JSON.stringify(result,null,2)); if(!result.pass) process.exitCode=1; }
 else { const result=await (opts.command==='session-snapshot'?runSnapshot(opts):run(opts)); await writeFile(opts.out,JSON.stringify(result,null,2)+'\n'); console.log(`측정 완료: ${result.scenario}`); }
} catch(e) { console.error(sanitize(e.message)); process.exitCode=1; }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
