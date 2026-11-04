import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ModelRunner, ModelUsage } from 'second_brain';

export const codexModelRunner: ModelRunner = {
  async run(input) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRAIN_') && key !== 'OPENAI_API_KEY' && key !== 'CODEX_API_KEY'));
    const args = ['exec', '-C', input.cwd, '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--json', '-c', 'project_root_markers=[]', '-c', `model_reasoning_effort=${input.effort}`, ...(input.model ? ['-m', input.model] : []), '--output-schema', input.schemaPath, '-o', input.outputPath, input.prompt];
    return await new Promise(resolve => {
      const child = spawn('codex', args, { cwd: input.cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
      const maxLineBytes = 65_536;
      let pending = '', dropping = false, finished = false;
      let usage: ModelUsage | null = null;
      const parseLine = (line: string) => {
        try { const event = JSON.parse(line); const u = event.type === 'turn.completed' ? event.usage : null;
          if (u && [u.input_tokens, u.cached_input_tokens, u.output_tokens].every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0)) usage = { inputTokens: u.input_tokens, cachedInputTokens: u.cached_input_tokens, outputTokens: u.output_tokens };
        } catch { /* Ignore non-events. */ }
      };
      const finish = async (code: number | null) => {
        if (finished) return; finished = true; clearTimeout(timer);
        if (code !== 0) { resolve({ ok: false, code: 'ANALYSIS_MODEL_FAILED' }); return; }
        if (!dropping && pending) parseLine(pending);
        try { resolve({ ok: true, output: await readFile(input.outputPath, 'utf8'), usage }); }
        catch { resolve({ ok: false, code: 'ANALYSIS_MODEL_FAILED' }); }
      };
      const timer = setTimeout(() => { child.stdout.destroy(); child.kill('SIGKILL'); void finish(null); }, input.timeoutMs);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
        for (const part of chunk.split(/(?<=\n)/)) {
          const ended = part.endsWith('\n');
          if (!dropping) {
            pending += part;
            if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) { pending = ''; dropping = true; }
          }
          if (ended) { if (!dropping) parseLine(pending); pending = ''; dropping = false; }
        }
      });
      child.once('error', () => { void finish(null); }); child.once('close', code => { void finish(code); });
    });
  },
};
