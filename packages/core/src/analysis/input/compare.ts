/** SQLite BINARY compares UTF-8 bytes, independently of the host locale. */
export function binaryCompare(a: string, b: string): number {
  const encoder = new TextEncoder(), left = encoder.encode(a), right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}
