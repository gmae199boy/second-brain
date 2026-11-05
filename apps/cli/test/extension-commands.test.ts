import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { extHome } from './ext-fixture.js';

it('exposes an installed read command through CLI, guide and MCP and follows activation', async () => {
  const fixture = await extHome();
  try {
    const install = await fixture.run(['ext', 'install', 'testext', '--json']);
    expect(install.body?.ok).toBe(true);
    expect((await fixture.run(['ext', 'testext', '--help'])).stdout).toContain('echo-stats');
    const guide = await fixture.run(['guide', 'schema', 'ext.testext', 'echo-stats', '--json']);
    expect(guide.body?.ok).toBe(true);
    const schema = guide.body.data.commands[0].input_schema;
    const selfId = (await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    await fixture.db.query("insert into brain.settings(user_id,key,value,updated_at) values (null,'testext.label','global-value',now())");
    expect((await fixture.run(['config', 'set', 'testext.label', 'user-value', '--json'])).body.ok).toBe(true);
    const call = await fixture.run(['ext', 'testext', 'echo-stats', '--input', '{"value":"hello"}', '--json']);
    expect(call.body?.ok).toBe(true);
    expect(call.body.data).toMatchObject({ abi: 1, settings: { 'testext.label': 'user-value' }, input: { value: 'hello' } });
    expect(call.body.data.user_id).toBe(selfId);
    const invalid = await fixture.run(['ext', 'testext', 'echo-stats', '--input', '{"value":7}', '--json']);
    expect(invalid.body?.error?.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'mcp', 'serve'], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    async function request(id: number, method: string, params: unknown = {}) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return JSON.parse((await lines.next()).value!); }
    try {
      for (const invalid of [null, 42, [], { jsonrpc: '1.0', id: 1, method: 'tools/list' }]) {
        child.stdin.write(JSON.stringify(invalid) + '\n'); expect(JSON.parse((await lines.next()).value!).error.code).toBe(-32600);
      }
      const id = 'password=hunter2x'; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize' }) + '\n');
      expect(JSON.parse((await lines.next()).value!).id).toBe(id);
      expect((await request(1, 'initialize')).result.capabilities.tools).toBeTruthy();
      const list = await request(2, 'tools/list');
      expect(list.result.tools[0].inputSchema).toEqual(schema);
      const result = await request(3, 'tools/call', { name: 'ext_testext_echo_stats', arguments: { value: 'hello' } });
      const mcpData = JSON.parse(result.result.content[0].text).data;
      expect(mcpData).toEqual(call.body.data);
      expect(mcpData).toMatchObject({ user_id: selfId, settings: { 'testext.label': 'user-value' } });
      expect((await fixture.run(['ext', 'disable', 'testext', '--json'])).body.ok).toBe(true);
      expect((await request(4, 'tools/list')).result.tools).toEqual([]);
      expect((await fixture.run(['ext', '--help'])).stdout).not.toContain('testext');
      expect((await fixture.run(['guide', 'schema', 'ext.testext', '--json'])).body.ok).toBe(false);
      expect((await request(5, 'tools/call', { name: 'ext_testext_echo_stats' })).result.isError).toBe(true);
      expect((await fixture.run(['ext', 'enable', 'testext', '--json'])).body.ok).toBe(true);
      expect((await request(6, 'tools/list')).result.tools).toHaveLength(1);
      const { rename } = await import('node:fs/promises'); const { join } = await import('node:path');
      const manifest = join(fixture.home, 'extensions/testext/manifest.json'); await rename(manifest, manifest + '.hidden');
      expect((await request(7, 'tools/list')).result.tools).toEqual([]);
      expect((await request(8, 'tools/call', { name: 'ext_testext_echo_stats' })).result.isError).toBe(true);
      await rename(manifest + '.hidden', manifest);
      await fixture.db.query("delete from brain.extensions where name='testext'");
      expect((await request(9, 'tools/list')).result.tools).toEqual([]);
      expect((await request(10, 'tools/call', { name: 'ext_testext_echo_stats' })).result.isError).toBe(true);
    } finally { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); }
  } finally { await fixture.cleanup(); }
}, 60000);

it('rejects invalid output, masks nested secrets and revalidates before CLI and MCP output', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    const dir = join(fixture.home, 'extensions/testext');
    const manifestPath = join(dir, 'manifest.json'), scriptPath = join(dir, 'bin/echo-stats.mjs');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(scriptPath, `process.stdout.write(JSON.stringify({nested:{value:'password=hunter2x'}}));`);
    original.commands[0].output_schema = { type: 'object', properties: { nested: { type: 'object', properties: { value: { enum: ['password=hunter2x'] } }, required: ['value'] } }, required: ['nested'] };
    await writeFile(manifestPath, JSON.stringify(original));
    const cli = await fixture.run(['ext', 'testext', 'echo-stats', '--json']);
    expect(cli.body.error.code).toBe('EXTENSION_COMMAND_OUTPUT_REDACTED');
    expect(cli.stdout).not.toContain('hunter2x');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'mcp', 'serve'], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ext_testext_echo_stats', arguments: {} } }) + '\n');
      const raw = (await lines.next()).value!;
      expect(raw).not.toContain('hunter2x'); expect(raw).toContain('EXTENSION_COMMAND_OUTPUT_REDACTED');
    } finally { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); }
    original.commands[0].output_schema = { type: 'object' }; await writeFile(manifestPath, JSON.stringify(original));
    const masked = await fixture.run(['ext', 'testext', 'echo-stats', '--json']);
    expect(masked.body.data.nested.value).toBe('password=[REDACTED:password]');
    const safeChild = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'mcp', 'serve'], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const safeLines = createInterface({ input: safeChild.stdout })[Symbol.asyncIterator]();
    try { safeChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ext_testext_echo_stats', arguments: {} } }) + '\n'); const safe = JSON.parse((await safeLines.next()).value!); expect(JSON.parse(safe.result.content[0].text).data).toEqual(masked.body.data); }
    finally { safeChild.stdin.end(); await new Promise(resolve => safeChild.once('close', resolve)); }
    await writeFile(scriptPath, `process.stdout.write('{}'); process.stderr.write('password=hunter2x'.repeat(100000));`);
    const stderrOverflow = await fixture.run(['ext', 'testext', 'echo-stats', '--json']);
    expect(stderrOverflow.body.error.code).toBe('EXTENSION_COMMAND_FAILED'); expect(stderrOverflow.body.data).toBeUndefined(); expect(stderrOverflow.stdout + stderrOverflow.stderr).not.toContain('hunter2x');
    await writeFile(scriptPath, `process.stdout.write(JSON.stringify({nested:{value:'password=hunter2x'}}));`);
    const text = await fixture.run(['ext', 'testext', 'echo-stats']);
    expect(text.stdout).toContain('[REDACTED:password]'); expect(text.stdout).not.toContain('hunter2x');
    for (const source of [`process.stdout.write('{')`, `process.exit(7)`, `process.stdout.write('x'.repeat(1100000))`, `process.stdout.write(JSON.stringify([]))`]) {
      await writeFile(scriptPath, source);
      const bad = await fixture.run(['ext', 'testext', 'echo-stats', '--json']);
      expect(bad.body.ok).toBe(false); expect(bad.body.data).toBeFalsy();
    }
  } finally { await fixture.cleanup(); }
}, 60000);

it('kills the process group and reaps its leader when a descendant holds output open', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    const dir = join(fixture.home, 'extensions/testext'), manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.commands[0].timeout_ms = 300;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(dir, 'bin/echo-stats.mjs'), `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'}); writeFileSync('pids.json',JSON.stringify([process.pid,c.pid])); setInterval(()=>{},1000);`);
    const result = await fixture.run(['ext', 'testext', 'echo-stats', '--json']);
    expect(result.body.error.code).toBe('EXTENSION_COMMAND_TIMEOUT');
    const pids = JSON.parse(await readFile(join(dir, 'pids.json'), 'utf8')) as number[];
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally { await fixture.cleanup(); }
}, 60000);

it('rejects write declarations on actual installation and exposes no command', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    const root = join(fixture.home, 'packages'); await mkdir(root);
    const dir = join(root, 'testext'); await cp(fileURLToPath(new URL('./fixtures/extensions/testext', import.meta.url)), dir, { recursive: true });
    const path = join(dir, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.commands[0].risk = 'write'; await writeFile(path, JSON.stringify(manifest));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', 'testext', '--json'], { env: { ...fixture.env, SECOND_BRAIN_TEST_EXTENSIONS: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', data => { stdout += data; });
    await new Promise(resolve => child.once('close', resolve));
    expect(JSON.parse(stdout).error.code).toBe('EXTENSION_INVALID');
    expect((await fixture.run(['guide', 'schema', 'ext.testext', '--json'])).body.ok).toBe(false);
  } finally { await fixture.cleanup(); }
}, 60000);

it('drops commands on missing manifest or registry, and does not enqueue work', async () => {
  const { rename } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    const before = await fixture.db.rows('select count(*)::int as count from brain.work_items');
    expect((await fixture.run(['ext', 'testext', 'echo-stats', '--json'])).body.ok).toBe(true);
    expect(await fixture.db.rows('select count(*)::int as count from brain.work_items')).toEqual(before);
    const manifest = join(fixture.home, 'extensions/testext/manifest.json');
    await rename(manifest, manifest + '.hidden');
    expect((await fixture.run(['guide', 'schema', 'ext.testext', '--json'])).body.ok).toBe(false);
    expect((await fixture.run(['ext', 'testext', 'echo-stats', '--json'])).body.ok).toBe(false);
    await rename(manifest + '.hidden', manifest);
    await fixture.db.query("delete from brain.extensions where name='testext'");
    expect((await fixture.run(['guide', 'schema', 'ext.testext', '--json'])).body.ok).toBe(false);
  } finally { await fixture.cleanup(); }
}, 60000);

it('rejects invalid input before launch and reports a missing self user', async () => {
  const { access, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    const dir = join(fixture.home, 'extensions/testext'), marker = join(dir, 'spawned');
    await writeFile(join(dir, 'bin/echo-stats.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('spawned','yes'); process.stdout.write('{}');`);
    const invalid = await fixture.run(['ext', 'testext', 'echo-stats', '--input', '{"value":42}', '--json']);
    expect(invalid.body.error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
    expect(await access(marker).then(() => true, () => false)).toBe(false);
    await fixture.db.query('update brain.users set is_self = 0 where is_self = 1');
    const missing = await fixture.run(['ext', 'testext', 'echo-stats', '--json']);
    expect(missing.body.error.code).toBe('USER_MISSING');
    expect(await access(marker).then(() => true, () => false)).toBe(false);
  } finally { await fixture.cleanup(); }
}, 60000);

it('rejects scalar, masked and async input schemas at installation without unhandled rejection', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    const root = join(fixture.home, 'packages'); await mkdir(root);
    const dir = join(root, 'testext'); await cp(fileURLToPath(new URL('./fixtures/extensions/testext', import.meta.url)), dir, { recursive: true });
    fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = root;
    const path = join(dir, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    for (const schema of [{ type: 'string' }, { type: 'object', properties: { value: { enum: ['password=hunter2x'] } } }, { $async: true, type: 'object' }]) {
      manifest.commands[0].input_schema = schema; await writeFile(path, JSON.stringify(manifest));
      const result = await fixture.run(['ext', 'install', 'testext', '--json']);
      expect(result.body.error.code).toBe('EXTENSION_INVALID'); expect(result.stderr).not.toContain('UnhandledPromiseRejection');
      expect((await fixture.run(['ext', 'testext', 'echo-stats', '--json'])).body.ok).toBe(false);
    }
  } finally { await fixture.cleanup(); }
}, 60000);

it.each(['SIGTERM', 'SIGINT'] as const)('cleans detached command and descendants when parent receives %s', async signal => {
  const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    const dir = join(fixture.home, 'extensions/testext'), file = join(dir, 'pids.json');
    const manifestPath = join(dir, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.commands[0].timeout_ms = 60000; await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(dir, 'bin/echo-stats.mjs'), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'}); writeFileSync('pids.json',JSON.stringify([process.pid,c.pid])); setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'testext', 'echo-stats', '--json'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const end = new Promise<number | null>(resolve => child.once('close', resolve));
    let pids: number[] = []; for (let i=0;i<100;i++) { try { pids = JSON.parse(await readFile(file, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
    expect(pids).toHaveLength(2); const started = Date.now(); child.kill(signal); expect(await Promise.race([end, new Promise(resolve => setTimeout(() => resolve('late'), 10000))])).toBe(signal === 'SIGTERM' ? 143 : 130); expect(Date.now() - started).toBeLessThan(10000);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally { await fixture.cleanup(); }
}, 60000);

it('cleans a pipe-holding descendant after the leader exits first', async () => {
  const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    const dir = join(fixture.home, 'extensions/testext');
    await writeFile(join(dir, 'bin/echo-stats.mjs'), `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));setTimeout(()=>process.exit(0),200);`);
    const result = await fixture.run(['ext', 'testext', 'echo-stats', '--json']); expect(result.body.ok).toBe(false);
    const pids = JSON.parse(await readFile(join(dir, 'pids.json'), 'utf8')) as number[];
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally { await fixture.cleanup(); }
}, 60000);

it('prepares Python for commands when connection check uses Node, including preparation failure', async () => {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    const root = join(fixture.home, 'packages'); await mkdir(root); const dir = join(root, 'pyfixture');
    await cp(fileURLToPath(new URL('./fixtures/extensions/pyfixture', import.meta.url)), dir, { recursive: true });
    const path = join(dir, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.connection_check = { runtime: 'node', entry: 'check.mjs' };
    manifest.commands = [{ name: 'echo-stats', runtime: 'python', entry: 'echo.py', description: 'echo', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 3000, risk: 'read' }];
    await writeFile(path, JSON.stringify(manifest)); await writeFile(join(dir, 'check.mjs'), `console.log(JSON.stringify({abi:1,type:'result',summary:'ok'}))`);
    await writeFile(join(dir, 'echo.py'), 'import json,sys\nprint(json.dumps(json.load(sys.stdin)))\n');
    fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = root; const testEnv: NodeJS.ProcessEnv = fixture.env; const originalPath = testEnv.PATH; testEnv.PATH = '';
    const failed = await fixture.run(['ext', 'install', 'pyfixture', '--json']); expect(failed.body.error.code).toBe('EXTENSION_UV_NOT_FOUND');
    expect(await fixture.ledger('pyfixture')).toEqual([]); testEnv.PATH = originalPath;
    expect((await fixture.run(['ext', 'install', 'pyfixture', '--json'])).body.ok).toBe(true);
    const cli = await fixture.run(['ext', 'pyfixture', 'echo-stats', '--input', '{"x":1}', '--json']);
    expect(cli.body.data).toMatchObject({ abi: 1, user_id: expect.any(String), settings: {}, input: { x: 1 } });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'mcp', 'serve'], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    try { child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ext_pyfixture_echo_stats',arguments:{x:1}}})+'\n'); const result=JSON.parse((await lines.next()).value!); expect(JSON.parse(result.result.content[0].text).data).toEqual(cli.body.data); }
    finally { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); }
  } finally { await fixture.cleanup(); }
}, 120000);

it('reports a registry database failure while static guide remains available', async () => {
  const fixture = await extHome();
  try {
    fixture.env.BRAIN_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unavailable';
    const guide = await fixture.run(['guide', 'schema', '--json']); expect(guide.body.ok).toBe(true);
    const command = await fixture.run(['ext', 'testext', 'echo-stats', '--json']); expect(command.body.error.code).toBe('DB_UNAVAILABLE');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'mcp', 'serve'], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    try {
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n'); expect(JSON.parse((await lines.next()).value!).error.data.code).toBe('DB_UNAVAILABLE');
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ext_testext_echo_stats'}})+'\n'); expect(JSON.parse((await lines.next()).value!).result.isError).toBe(true);
    } finally { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); }
  } finally { await fixture.cleanup(); }
}, 60000);

it('rejects async schemas synchronously without unhandled rejection', async () => {
  const { validateSchema, validateValue } = await import('../src/runtime/json-schema.js');
  const schema = { $async: true, type: 'object', required: ['required'] };
  const unhandled: unknown[] = []; const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try { expect(validateSchema(schema)).toBe(false); expect(validateValue(schema, {})).toBe(false); await new Promise(resolve => setTimeout(resolve, 20)); expect(unhandled).toEqual([]); }
  finally { process.removeListener('unhandledRejection', record); }
});

it('preserves final output schema across CLI JSON, text and MCP codecs', async () => {
  const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext','install','testext','--json'])).body.ok).toBe(true);
    const dir=join(fixture.home,'extensions/testext'), path=join(dir,'manifest.json'), script=join(dir,'bin/echo-stats.mjs');
    const manifest=JSON.parse(await readFile(path,'utf8')); manifest.commands[0].output_schema={type:'object',properties:{password:{type:'string'}},required:['password']};
    await writeFile(path,JSON.stringify(manifest)); await writeFile(script,`process.stdout.write('{"password":"hunter2x","__proto__":{"safe":true}}')`);
    const cli=await fixture.run(['ext','testext','echo-stats','--json']); expect(cli.body.ok).toBe(true); expect(cli.stdout).not.toContain('hunter2x');
    expect(Object.hasOwn(cli.body.data,'__proto__')).toBe(true); expect(cli.body.data.password).not.toContain('hunter2x');
    const text=await fixture.run(['ext','testext','echo-stats']); expect(text.stdout).not.toContain('hunter2x'); expect(JSON.parse(text.stdout.trim())).toEqual(cli.body.data);
    const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'mcp','serve'],{env:fixture.env,stdio:['pipe','pipe','pipe']}); const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    async function call(value?: unknown) { child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ext_testext_echo_stats',...(arguments.length ? {arguments:value} : {})}})+'\n'); return JSON.parse((await lines.next()).value!); }
    try {
      expect(JSON.parse((await call()).result.content[0].text).data).toEqual(cli.body.data);
      const cliNull = await fixture.run(['ext','testext','echo-stats','--input','null','--json']);
      expect(cliNull.body.error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
      expect(JSON.parse((await call(null)).result.content[0].text).error.code).toBe(cliNull.body.error.code);
      manifest.commands[0].output_schema.properties.password={enum:['hunter2x']}; await writeFile(path,JSON.stringify(manifest));
      const invalid=await fixture.run(['ext','testext','echo-stats','--json']); expect(invalid.body.error.code).toBe('EXTENSION_COMMAND_OUTPUT_REDACTED'); expect(invalid.stdout).not.toContain('hunter2x');
      const remote=JSON.stringify(await call()); expect(remote).toContain('EXTENSION_COMMAND_OUTPUT_REDACTED'); expect(remote).not.toContain('hunter2x');
    } finally { child.stdin.end(); await new Promise(resolve=>child.once('close',resolve)); }
    manifest.commands[0].output_schema={type:'object',properties:{value:{type:'number'}},required:['value']}; await writeFile(path,JSON.stringify(manifest));
    await writeFile(script,`process.stdout.write('{"value":1e400}')`); const infinite=await fixture.run(['ext','testext','echo-stats','--json']); expect(infinite.body.error.code).toBe('EXTENSION_COMMAND_OUTPUT_INVALID');
    manifest.commands[0].output_schema={type:'string',format:'password=hunter2x'}; await writeFile(path,JSON.stringify(manifest));
    const warning=await fixture.run(['ext','testext','echo-stats','--json']); expect(warning.stderr).not.toContain('hunter2x');
    const help=await fixture.run(['ext','testext','echo-stats','--help']); expect(help.stdout).toContain('3000ms'); expect(help.stdout).toContain('1MiB'); expect(help.stdout).toContain('30초');
  } finally { await fixture.cleanup(); }
},60000);

it('cancels and reaps the active process group when MCP stdin closes', async () => {
  const {readFile,writeFile}=await import('node:fs/promises'); const {join}=await import('node:path'); const fixture=await extHome();
  try {
    expect((await fixture.run(['ext','install','testext','--json'])).body.ok).toBe(true);
    const dir=join(fixture.home,'extensions/testext'), path=join(dir,'manifest.json'); const manifest=JSON.parse(await readFile(path,'utf8')); manifest.commands[0].timeout_ms=60000; await writeFile(path,JSON.stringify(manifest));
    await writeFile(join(dir,'bin/echo-stats.mjs'),`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`);
    const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'mcp','serve'],{env:fixture.env,stdio:['pipe','pipe','pipe']}); const end=new Promise(resolve=>child.once('close',resolve));
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ext_testext_echo_stats'}})+'\n');
    let pids: number[]=[]; for(let i=0;i<100;i++){try{pids=JSON.parse(await readFile(join(dir,'pids.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
    expect(pids).toHaveLength(2); const started=Date.now(); child.stdin.end(); expect(await Promise.race([end,new Promise(resolve=>setTimeout(()=>resolve('late'),10000))])).not.toBe('late'); expect(Date.now()-started).toBeLessThan(10000);
    for(const pid of pids) expect(()=>process.kill(pid,0)).toThrow();
  } finally { await fixture.cleanup(); }
},60000);

it('validates own properties and rejects unsupported proto schemas without rejecting proto data', async () => {
  const { validateSchema, validateValue } = await import('../src/runtime/json-schema.js');
  for (const key of ['constructor', 'toString', '__proto__']) {
    const schema = { type: 'object', required: [key] };
    expect(validateValue(schema, {})).toBe(false);
    expect(validateValue(schema, JSON.parse(`{"${key}":42}`))).toBe(true);
  }
  const unsupported = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
  expect(validateSchema(unsupported)).toBe(false);
  const unsupportedPattern = JSON.parse('{"type":"object","patternProperties":{"__proto__":{"type":"string"}}}');
  expect(validateSchema(unsupportedPattern)).toBe(false);
  const dataSchema = JSON.parse('{"type":"object","const":{"properties":{"__proto__":123}}}');
  expect(validateSchema(dataSchema)).toBe(true);
  expect(validateValue({ type: 'object' }, { nested: [Infinity] })).toBe(false);
});

it('rejects nonfinite JSON values independently of loose schema and invalid MCP numeric IDs', async () => {
  const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const fixture = await extHome();
  try {
    expect((await fixture.run(['ext','install','testext','--json'])).body.ok).toBe(true);
    const dir = join(fixture.home,'extensions/testext'), path = join(dir,'manifest.json');
    const manifest = JSON.parse(await readFile(path,'utf8')); manifest.commands[0].input_schema = { type:'object' }; manifest.commands[0].output_schema = { type:'object' }; await writeFile(path,JSON.stringify(manifest));
    const cli = await fixture.run(['ext','testext','echo-stats','--input','{"x":1e400}','--json']); expect(cli.body.error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
    const child = spawn(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'mcp','serve'],{env:fixture.env,stdio:['pipe','pipe','pipe']});
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    try {
      child.stdin.write('{"jsonrpc":"2.0","id":1e400,"method":"initialize"}\n'); expect(JSON.parse((await lines.next()).value!).error.code).toBe(-32600);
      child.stdin.write('{"jsonrpc":"2.0","id":-1.5,"method":"initialize"}\n'); expect(JSON.parse((await lines.next()).value!).id).toBe(-1.5);
      child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ext_testext_echo_stats","arguments":{"x":1e400}}}\n');
      expect(JSON.parse(JSON.parse((await lines.next()).value!).result.content[0].text).error.code).toBe('EXTENSION_COMMAND_INPUT_INVALID');
      await writeFile(join(dir,'bin/echo-stats.mjs'), `process.stdout.write('{"nested":[1e400]}')`);
      const output = await fixture.run(['ext','testext','echo-stats','--json']); expect(output.body.error.code).toBe('EXTENSION_COMMAND_OUTPUT_INVALID');
      child.stdin.write('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ext_testext_echo_stats","arguments":{}}}\n');
      expect(JSON.parse(JSON.parse((await lines.next()).value!).result.content[0].text).error.code).toBe('EXTENSION_COMMAND_OUTPUT_INVALID');
    } finally { child.stdin.end(); await new Promise(resolve => child.once('close', resolve)); }
  } finally { await fixture.cleanup(); }
},60000);

it('guards compiled schema references and dependencies without treating literal data as schemas', async () => {
  const { validateSchema, validateValue } = await import('../src/runtime/json-schema.js');
  const cases: readonly [string, boolean][] = [
    ['{"$id":"https://example.invalid/schema","type":"object","hidden":{"properties":{"__proto__":{"type":"string"}}},"$ref":"https://example.invalid/schema#/hidden"}', false],
    ['{"$id":"https://example.invalid/root","type":"object","$defs":{"scope":{"$id":"https://example.invalid/inner","hidden":{"properties":{"__proto__":{"type":"string"}}},"$ref":"https://example.invalid/inner#/hidden"}},"$ref":"https://example.invalid/inner"}', false],
    ['{"$id":"https://example.invalid/root","type":"object","$defs":{"scope":{"$id":"inner","hidden":{"properties":{"__proto__":{"type":"string"}}},"$ref":"#/hidden"}},"$ref":"inner"}', false],
    ['{"$id":"https://example.invalid/root","type":"object","$defs":{"scope":{"$id":"inner","hidden":{"properties":{"name":{"type":"string"}}},"$ref":"#/hidden"}},"$ref":"inner"}', true],
    ['{"type":"object","dependencies":{"trigger":{"properties":{"__proto__":{"type":"string"}}}}}', false],
    ['{"type":"object","$defs":{"unused":{"$ref":"#/$defs/missing"}}}', true],
    ['{"type":"object","$defs":{"unused":{"$ref":"https://example.invalid/missing"}}}', true],
    ['{"type":"object","$ref":"#/$defs/missing"}', false],
    ['{"type":"object","$ref":"https://example.invalid/missing"}', false],
    ['{"$id":"https://example.invalid/safe","type":"object","hidden":{"properties":{"name":{"type":"string"}}},"$ref":"https://example.invalid/safe#/hidden"}', true],
    ['{"type":"object","dependencies":{"trigger":{"properties":{"name":{"type":"string"}}}}}', true],
    ['{"type":"object","dependencies":{"trigger":["__proto__"]}}', true],
    ['{"type":"object","const":{"properties":{"__proto__":42}},"enum":[{"properties":{"__proto__":42}}],"default":{"properties":{"__proto__":42}},"examples":[{"properties":{"__proto__":42}}]}', true],
  ];
  for (const [text, expected] of cases) expect(validateSchema(JSON.parse(text)), text).toBe(expected);
  const ordinary = JSON.parse('{"type":"object","properties":{"name":{"type":"string"}}}');
  expect(validateValue(ordinary, { name: 'ok' })).toBe(true);
  expect(validateValue(ordinary, { name: 42 })).toBe(false);
});

it('지속 quiesce 중 명령은 시작하지 않고 소유한 정지 해제 후 다시 실행한다', async () => {
  const fixture = await extHome();
  const { postgresStore } = await import('second_brain/postgres');
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  const owner = '00000000-0000-7000-8000-000000000001';
  try {
    expect((await fixture.run(['ext', 'install', 'testext', '--json'])).body.ok).toBe(true);
    expect(await store.beginExtensionQuiesce({ name:'testext', owner, now:new Date() })).toEqual({ok:true,acquired:true});
    const blocked = await fixture.run(['ext','testext','echo-stats','--json']);
    expect(blocked.body.error.code).toBe('EXTENSION_COMMAND_UNAVAILABLE');
    expect(await store.endExtensionQuiesce({name:'testext',owner:'00000000-0000-7000-8000-000000000002'})).toEqual({ok:true,released:false});
    expect(await store.endExtensionQuiesce({name:'testext',owner})).toEqual({ok:true,released:true});
    expect((await fixture.run(['ext','testext','echo-stats','--json'])).body.ok).toBe(true);
  } finally { await store.close(); await fixture.cleanup(); }
},60000);
