import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupervisorCandidate } from './supervisor-candidate.mjs';

test('supervisor staging은 고정 입력에서 같은 manifest를 만들고 운영 설치로 표시하지 않는다',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'brain-supervisor-candidate-'));
  try {
    const pin={launcherUid:process.getuid(),launcherHash:'1'.repeat(40)};
    const one=await createSupervisorCandidate(join(parent,'one'),pin),two=await createSupervisorCandidate(join(parent,'two'),pin);
    assert.equal(one.packageHash,two.packageHash);assert.ok(one.files>5);assert.equal(one.productionReady,false);assert.equal(one.licenseStatus,'unverified');
    assert.equal(await readFile(join(one.root,'registry/supervisor.registry'),'utf8'),await readFile(join(two.root,'registry/supervisor.registry'),'utf8'));
    assert.ok((await stat(join(one.root,'payload/licenses/node-LICENSE'))).size>0);
    const bundle=await readFile(join(one.root,'payload/supervisor/main.js'),'utf8');assert.doesNotMatch(bundle,/__require\("pg-native"\)/u);assert.match(bundle,/createInstalledProtectedService/u);
    assert.match(await readFile(join(one.root,'payload/licenses/NOTICE'),'utf8'),/pg-types.*pgpass/u);
    await assert.rejects(createSupervisorCandidate(join(parent,'invalid'),{launcherUid:pin.launcherUid,launcherHash:'0'.repeat(40)}));
    const existing=join(parent,'existing');await writeFile(existing,'preserve');await assert.rejects(createSupervisorCandidate(existing,pin));assert.equal(await readFile(existing,'utf8'),'preserve');
  } finally {await rm(parent,{recursive:true,force:true});}
});
