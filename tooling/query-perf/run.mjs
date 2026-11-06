#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, compare } from './src/core.mjs';
import { run } from './src/import-cleanup.mjs';
try {
 const opts=parseArgs(process.argv.slice(2));
 if (opts.command==='compare') { const result=compare(JSON.parse(await readFile(opts.base,'utf8')),JSON.parse(await readFile(opts.change,'utf8'))); console.log(JSON.stringify(result,null,2)); if(!result.pass) process.exitCode=1; }
 else { const result=await run(opts); await writeFile(opts.out,JSON.stringify(result,null,2)+'\n'); console.log(`측정 완료: ${result.runs.length} 조건`); }
} catch(e) { console.error(e.message); process.exitCode=1; }
