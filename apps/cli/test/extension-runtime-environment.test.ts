import { describe, expect, it } from 'vitest';
import { extensionRuntimeEnvironment } from '../src/daemon/supervisor.js';

describe('supervised extension runtime environment', () => {
  it('passes the supplied executable lookup and login locations without unrelated variables', () => {
    expect(extensionRuntimeEnvironment({ HOME: '/synthetic/home', PATH: '/synthetic/bin', CODEX_HOME: '/synthetic/codex', CLAUDE_CONFIG_DIR: '/synthetic/claude', XDG_CONFIG_HOME: '/synthetic/config', OPENAI_API_KEY: 'secret' })).toEqual({
      HOME: '/synthetic/home', PATH: '/synthetic/bin', CODEX_HOME: '/synthetic/codex', CLAUDE_CONFIG_DIR: '/synthetic/claude', XDG_CONFIG_HOME: '/synthetic/config',
    });
  });
  it('omits absent values and does not fall back to the host environment', () => {
    expect(extensionRuntimeEnvironment({ PATH: '/synthetic/bin' })).toEqual({ PATH: '/synthetic/bin' });
  });
});
