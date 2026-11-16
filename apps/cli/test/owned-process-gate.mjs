// Private process-group leader. The parent verifies and releases it before it starts the target.
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { Socket } from 'node:net';

const send = value => writeSync(3, `${JSON.stringify(value)}\n`);
const channel = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true });
let input = '';
channel.setEncoding('utf8');
channel.on('data', chunk => { input += chunk; });
channel.on('error', () => process.exit(125));
channel.on('end', () => {
  try {
    const { command, args, env, argv0 } = JSON.parse(input);
    send({ state: 'armed' });
    process.kill(process.pid, 'SIGSTOP');
    send({ state: 'attempt' });
    const target = spawn(command, args, { env, argv0, detached: false, stdio: ['ignore', 'inherit', 'inherit'] });
    // The caller and the cleanup supervisor signal the whole group directly.
    // The leader waits for the target; forwarding here would signal it twice.
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
    const handlers = new Map(signals.map(signal => [signal, () => {}]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let failed = false;
    target.once('error', error => {
      failed = true;
      send({ state: 'error', code: error.code, errno: error.errno });
    });
    target.once('spawn', () => send({ state: 'started', pid: target.pid }));
    target.once('close', (code, signal) => {
      if (failed) { process.exit(126); return; }
      if (signal) {
        const handler = handlers.get(signal);
        if (handler) process.removeListener(signal, handler);
        process.kill(process.pid, signal); return;
      }
      process.exit(code ?? 125);
    });
  } catch {
    try { send({ state: 'invalid' }); } catch { /* parent quarantines an incomplete channel */ }
    process.exit(125);
  }
});
