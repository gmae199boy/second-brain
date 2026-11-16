export function classifyChanges(paths: string[]): {
  pythonAll: boolean;
  pythonFiles: string[];
  postgresAll: boolean;
  reasons: { prefix: string; reason: string }[];
};
export function explicitTestsForChanges(paths: string[]): string[];
