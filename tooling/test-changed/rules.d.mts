export function classifyChanges(paths: string[]): {
  pythonAll: boolean;
  pythonFiles: string[];
  postgresAll: boolean;
  analysisTracer: boolean;
  analysisInput: boolean;
  reasons: { prefix: string; reason: string }[];
};
