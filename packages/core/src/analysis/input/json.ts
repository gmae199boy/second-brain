/** Preserve integer tokens outside the safe Number range through JSON output. */
export function parseInputJson(text: string): unknown {
  return (JSON.parse as (text: string, reviver: (key: string, value: unknown, context: {source?: string}) => unknown) => unknown)(text, (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context.source && /^-?\d+$/.test(context.source)) return BigInt(context.source);
    return value;
  });
}
export function stringifyInputJson(value: unknown, indent?: number): string {
  const raw = (JSON as unknown as {rawJSON(text: string): unknown}).rawJSON;
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? raw(item.toString()) : item, indent);
}
/** Python json.dumps defaults, including spaces after separators. */
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}: ${pythonJson(v)}`).join(', ')}}`;
  return stringifyInputJson(value);
}
