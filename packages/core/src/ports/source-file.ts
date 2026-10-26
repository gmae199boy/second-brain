/** Read-only access to an attachment source. Failures are values, never throws. */
export interface SourceFileReader {
  read(path: string, maxBytes: number): Promise<
    { ok: true; bytes: Uint8Array } | { ok: false; message: string }
  >;
}
