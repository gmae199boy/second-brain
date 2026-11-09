// Test-only fault injection; no runtime switches are added to the runner.
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
if (process.argv[1]?.endsWith('/tooling/test-changed/run.mjs')) {
  const write = fs.writeFileSync;
  const rename = fs.renameSync;
  const spawn = cp.spawnSync;
  let published = 0;
  fs.writeFileSync = function (path, ...args) {
    if (process.env.FAULT_KIND === 'write' && published >= 1 && String(path).endsWith('.tmp')) throw Object.assign(new Error('injected secret'), {code:'EIO'});
    return write.call(this, path, ...args);
  };
  fs.renameSync = function (from, to) {
    if (process.env.FAULT_KIND === 'rename' && published >= 1 && String(from).endsWith('.tmp')) throw Object.assign(new Error('injected secret'), {code:'EIO'});
    const value = rename.call(this, from, to);
    if (String(to).endsWith('.json')) published++;
    return value;
  };
  cp.spawnSync = function (executable, argv, options) {
    if (process.env.FAULT_SPAWN && executable === 'pnpm' && argv[0] === 'build') {
      fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify([executable, ...argv]) + '\n');
      return {status:null, signal:'SIGTERM', stdout:'', stderr:'', error:Object.assign(new Error('injected secret'), {code:process.env.FAULT_SPAWN})};
    }
    return spawn.call(this, executable, argv, options);
  };
  syncBuiltinESMExports();
}
