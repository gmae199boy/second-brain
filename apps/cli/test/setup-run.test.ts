import { describe, expect, it } from 'vitest';
import { setupRunFlags } from '../src/commands/setup-run.js';

describe('setup run installer flags', () => {
  it.each([
    [{}, []],
    [{ connect: ['claude-code'] }, ['claude-code']],
    [{ connect: ['claude-code', 'demo', 'claude-code'] }, ['claude-code', 'demo', 'claude-code']],
    [{ connect: ['claude-code', 1, null] }, ['claude-code']],
  ])('maps connect from %j', (options, connect) => {
    expect(setupRunFlags(options)).toEqual({ storePath: undefined, mirrorPath: undefined,
      pluginRoot: undefined, connect, yes: false, help: false });
  });
  it('keeps the other installer options', () => {
    expect(setupRunFlags({ storePath: '/db', mirrorPath: '/mirror', pluginRoot: '/plugin', yes: true }))
      .toEqual({ storePath: '/db', mirrorPath: '/mirror', pluginRoot: '/plugin', connect: [], yes: true, help: false });
  });
});
