import Ajv2020Module from 'ajv/dist/2020.js';
import type { CodeKeywordDefinition } from 'ajv';
import { hasOnlyFiniteNumbers } from 'second_brain';
const Ajv2020 = Ajv2020Module.default;

/** Guard exactly the schema nodes Ajv compiles, including referenced scopes. */
function compile(schema: Record<string, unknown>) {
  const ajv = new Ajv2020({ strict: false, strictNumbers: true, ownProperties: true, logger: false });
  for (const keyword of ['properties', 'patternProperties']) {
    const definition = ajv.getKeyword(keyword);
    if (!definition || typeof definition === 'boolean' || !('code' in definition) || typeof definition.code !== 'function') throw new Error('schema validator unavailable');
    // Each Ajv instance owns its keyword definition; preserve rule ordering
    // and delegate to its original implementation after the guard.
    const code = definition.code;
    (definition as CodeKeywordDefinition).code = (context, ruleType) => {
      if (context.schema && typeof context.schema === 'object' && Object.hasOwn(context.schema, '__proto__')) throw new Error('unsupported schema property');
      code(context, ruleType);
    };
  }
  const compiled = ajv.compile(schema);
  return (compiled as { $async?: boolean }).$async === true ? undefined : compiled;
}
export function validateSchema(schema: Record<string, unknown>): boolean {
  try { return compile(schema) !== undefined; } catch { return false; }
}
export function validateValue(schema: Record<string, unknown>, value: unknown): boolean {
  try { return hasOnlyFiniteNumbers(value) && compile(schema)?.(value) === true; } catch { return false; }
}
