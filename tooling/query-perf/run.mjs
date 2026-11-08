#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, compare, sanitize } from './src/core.mjs';
import { run } from './src/import-cleanup.mjs';
import { run as runAttachments } from './src/attachments.mjs';
import { run as runSnapshot } from './src/session-snapshot.mjs';
import { run as defaultCommonSearch } from './src/common-search.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const clean = value => typeof value === 'string' ? sanitize(value) : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])) : value;
export async function main(args = process.argv.slice(2), internal = {}) {
let opts;
try {
 opts=parseArgs(args);
 if (opts.command==='compare') { const result=compare(JSON.parse(await readFile(opts.base,'utf8')),JSON.parse(await readFile(opts.change,'utf8'))); console.log(JSON.stringify(result,null,2)); if(!result.pass) process.exitCode=1; }
 else { let result; if(opts.command==='common-search') { try { result=await (internal.runCommonSearch ?? defaultCommonSearch)(opts); } catch(error) { await writeFile(opts.out,JSON.stringify({scenario:'common-search',status:'failed',message:sanitize(error.message),resources:error.resources ?? null,evidence:clean(error.evidence ?? null)},null,2)+'\n'); throw error; } } else result=await (opts.command==='file-locations'?(internal.runLocations ?? (await import('./src/file-locations.mjs')).run)(opts):opts.command==='session-snapshot'?runSnapshot(opts):opts.command==='write-attachments'?runAttachments(opts):run(opts)); await writeFile(opts.out,JSON.stringify(opts.command==='file-locations'?clean(result):result,null,2)+'\n'); console.log(`측정 완료: ${result.scenario}`); }
} catch(e) { if(opts?.command==='file-locations' && opts.out) { try { await writeFile(opts.out,JSON.stringify(clean(e.raw ?? {scenario:'file-locations',failed:true,error:e.message,resources:e.resources ?? null}),null,2)+'\n'); } catch(writeError) { console.error(sanitize(writeError.message)); } } console.error(sanitize(e.message)); process.exitCode=1; }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
