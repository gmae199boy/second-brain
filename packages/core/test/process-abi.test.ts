import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { decodeAbiLine, PROCESS_ABI_FIXTURES_URL, PROCESS_ABI_SCHEMA_URL } from '../dist/index.js';
it('ships the ABI schema and every fixture agrees with the codec', async () => {
  const schema = JSON.parse(await readFile(PROCESS_ABI_SCHEMA_URL, 'utf8'));
  expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(schema.oneOf.map((branch: any) => branch.properties.type.const)).toEqual(['progress', 'result']);
  const cases = JSON.parse(await readFile(PROCESS_ABI_FIXTURES_URL, 'utf8'));
  for (const fixture of cases) expect(decodeAbiLine(fixture.line).ok, fixture.name).toBe(fixture.expect === 'valid');
});
