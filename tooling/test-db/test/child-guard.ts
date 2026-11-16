import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
// Load the fixed observer before replacing child_process exports.
import '../src/slots/internal-ps.js';

type Interceptor = (key: string, fn: (...args: any[]) => any, receiver: unknown, args: any[]) => any;
let current: Interceptor | undefined;
let interceptionDepth = 0;
const originalsByWrapper = new WeakMap<Function, (...args: any[]) => any>();

/** Record every child before it can start; uncertain children fence recovery. */
export function installChildGuard(path: string, append: (record: object) => void = record => appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 })): () => void {
  const write = append;
  write({ state: 'begin' });
  const originals = new Map<string, (...args: any[]) => any>();
  const wrappers = new Map<string, (...args: any[]) => any>();
  const previous = current;
  const intercept: Interceptor = (key, fn, receiver, args) => {
      if (interceptionDepth) return fn.apply(receiver, args);
      const token = randomBytes(12).toString('hex');
      // A command name or the direct child's close is not proof that its descendants exited.
      const tool = false;
      write({ state: 'spawned', token, tool });
      let result: any;
      interceptionDepth++;
      try { result = fn.apply(receiver, args); } finally { interceptionDepth--; }
      if (key.endsWith('Sync')) {
        if (tool) write({ state: 'completed', token });
      } else {
        const child = result?.child ?? result;
        if (child && typeof child === 'object') Object.defineProperty(child, Symbol.for('brain.test.child-token'), { value: token });
        if (Number.isInteger(child?.pid)) {
          try { write({ state: 'pid', token, pid: child.pid }); }
          catch (error) { Object.defineProperty(child, Symbol.for('brain.test.child-journal-error'), { value: error }); }
        }
        if (tool && child?.once) child.once('close', () => write({ state: 'completed', token }));
      }
      return result;
  };
  current = intercept;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    const mutable = childProcess as unknown as Record<string, (...args: any[]) => any>;
    const original = mutable[key]!; originals.set(key, original);
    const base = originalsByWrapper.get(original) ?? original;
    const call = (fn: typeof original, receiver: unknown, args: any[]) => current ? current(key, fn, receiver, args) : fn.apply(receiver, args);
    const wrapped = function (this: unknown, ...args: any[]) { return call(base, this, args); };
    originalsByWrapper.set(wrapped, base);
    const custom = (base as unknown as Record<symbol, ((...args: any[]) => any)>)[promisify.custom];
    if (custom) Object.defineProperty(wrapped, promisify.custom, { value: function (this: unknown, ...args: any[]) { return call(custom, this, args); } });
    wrappers.set(key, wrapped); mutable[key] = wrapped;
  }
  syncBuiltinESMExports();
  let closed = false;
  return () => {
    if (closed) return; closed = true;
    try { write({ state: 'sealed' }); } finally {
      if (current === intercept) current = previous;
      const mutable = childProcess as unknown as Record<string, (...args: any[]) => any>;
      for (const [key, original] of originals) if (mutable[key] === wrappers.get(key)) mutable[key] = original;
      syncBuiltinESMExports();
    }
  };
}
