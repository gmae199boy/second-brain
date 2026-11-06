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
  // Ajv can recursively resolve a pointer into an embedded resource whose
  // root has both $id and $ref. Register that resource explicitly before
  // compiling the containing schema, preserving its resolved base URI.
  const input = structuredClone(schema);
  const embedded: Record<string, unknown>[] = [];
  function collect(node: unknown, base: string, root = false): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const value = node as Record<string, unknown>;
    if (typeof value['$id'] === 'string') {
      base = base ? ajv.opts.uriResolver.resolve(base, value['$id']) : value['$id'];
      if (!root && typeof value['$ref'] === 'string' && base) {
        value['$id'] = base;
        embedded.push(value);
      }
    }
    for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies']) {
      const children = value[key];
      if (children && typeof children === 'object' && !Array.isArray(children))
        for (const child of Object.values(children)) collect(child, base);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      const children = value[key];
      if (Array.isArray(children)) for (const child of children) collect(child, base);
    }
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']) collect(value[key], base);
  }
  collect(input, '', true);
  for (const resource of embedded.reverse()) ajv.addSchema(resource);
  const compiled = ajv.compile(input);
  return (compiled as { $async?: boolean }).$async === true ? undefined : compiled;
}
export function validateSchema(schema: Record<string, unknown>): boolean {
  try { return compile(schema) !== undefined; } catch { return false; }
}
export function validateValue(schema: Record<string, unknown>, value: unknown): boolean {
  try { return hasOnlyFiniteNumbers(value) && compile(schema)?.(value) === true; } catch { return false; }
}
