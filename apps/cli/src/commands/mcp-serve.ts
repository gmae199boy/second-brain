import type { CommandSpec } from '../dispatch.js';
import { serveMcp } from '../mcp/serve.js';
export const mcpServeCommand: CommandSpec = {
  ns: 'mcp', verb: 'serve', usedFor: 'MCP stdio 서버를 실행합니다', required: [], examples: ['brain mcp serve'],
  output: 'MCP 프로토콜', risk: 'read', hook: false, dryRun: false, standalone: true, envelope: false,
  async run(context) { await serveMcp(context.env); return { ok: true, data: null }; },
};
