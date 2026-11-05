import { maskOutputValue } from 'second_brain';
import { createInterface } from 'node:readline';
import { dynamicExtensionCommands } from '../runtime/extension-commands.js';
import { dispatch } from '../dispatch.js';
import { systemClock } from '../runtime/clock.js';

export async function serveMcp(env: NodeJS.ProcessEnv): Promise<void> {
  const transport = new AbortController();
  process.stdin.once('end', () => transport.abort()); process.stdin.once('close', () => transport.abort());
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (value: { id: unknown; [key: string]: unknown }) => { const { id, ...body } = value; process.stdout.write(JSON.stringify({ ...maskOutputValue(body), id }) + '\n'); };
  for await (const line of lines) {
    let request: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (Object.hasOwn(request, 'id') && request.id !== null && typeof request.id !== 'string' && (typeof request.id !== 'number' || !Number.isFinite(request.id))) || (request.params !== undefined && (request.params === null || typeof request.params !== 'object' || Array.isArray(request.params)))) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); continue; }
    if (!Object.hasOwn(request, 'id')) continue;
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'second-brain', version: '1' } };
    else if (request.method === 'tools/list') {
      const registry = await dynamicExtensionCommands(env);
      if (!registry.ok) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: registry.message, data: { code: registry.code } } }); continue; }
      result = { tools: registry.commands.map(spec => ({ name: `${spec.ns.replace('.', '_')}_${spec.verb}`.replaceAll('-', '_'), description: spec.usedFor, inputSchema: spec.inputSchema })) };
    } else if (request.method === 'tools/call') {
      const registry = await dynamicExtensionCommands(env);
      if (!registry.ok) { result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: registry.code, message: registry.message } }) }] }; send({ jsonrpc: '2.0', id: request.id, result }); continue; }
      const spec = registry.commands.find(item => `${item.ns.replace('.', '_')}_${item.verb}`.replaceAll('-', '_') === request.params?.name);
      if (!spec) result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'EXTENSION_COMMAND_UNAVAILABLE', message: '등록된 확장 명령이 없습니다' } }) }] };
      else {
        let output = '';
        await dispatch(registry.commands, ['ext', spec.ns.slice(4), spec.verb, '--json'], { clock: systemClock, env, signal: transport.signal, rawExtensionInput: { value: request.params && Object.hasOwn(request.params, 'arguments') ? request.params.arguments : {} }, stdout: text => { output += text; }, stderr: () => {} });
        let envelope: { ok?: boolean }; try { envelope = JSON.parse(output); } catch { envelope = { ok: false }; }
        result = { ...(envelope.ok ? {} : { isError: true }), content: [{ type: 'text', text: output.trim() }] };
      }
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); continue; }
    send({ jsonrpc: '2.0', id: request.id, result });
  }
}
