const cp = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');
const log = process.env.BRAIN_PROCESS_SPY;
const restricted = process.env.BRAIN_RESTRICTED_PATH;
if (log && restricted) {
  process.env.PATH = restricted;
  const forbidden = /(?:^|[\s/'"=])(?:python(?:3(?:\.\d+)?)?|uv)(?:$|[\s/'";])/i;
  const record = (kind, args) => {
    const text = args.map(value => typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : '').join(' ');
    fs.appendFileSync(log, JSON.stringify({ kind, text }) + '\n');
    if (forbidden.test(text)) throw new Error(`차단된 Python 또는 uv 탐색: ${text}`);
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    const wrapper = function (...args) { record(name, args.slice(0, 2)); return original.apply(this, args); };
    const custom = original[promisify.custom];
    if (custom) wrapper[promisify.custom] = function (...args) { record(name, args.slice(0, 2)); return custom.apply(this, args); };
    cp[name] = wrapper;
  }
  for (const name of ['access', 'accessSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'existsSync', 'open', 'openSync', 'readFile', 'readFileSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      if (typeof args[0] === 'string' && forbidden.test(args[0])) record(`fs.${name}`, [args[0]]);
      return original.apply(this, args);
    };
  }
  for (const name of ['access', 'stat', 'lstat', 'open', 'readFile']) {
    const original = fs.promises[name];
    fs.promises[name] = function (...args) {
      if (typeof args[0] === 'string' && forbidden.test(args[0])) record(`fs.promises.${name}`, [args[0]]);
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
