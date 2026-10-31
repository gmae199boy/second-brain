import { maskSecrets, SECRET_PATTERN_VERSION } from 'second_brain';

// stdin만 검사하고 결과에는 내용이나 일치 위치를 내보내지 않는다.
try {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 32 * 1024 * 1024) throw Error('too large');
    chunks.push(bytes);
  }
  const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  // UTF-16 등 NUL을 포함한 불명 텍스트는 안전한 UTF-8 로그로 취급하지 않는다.
  if (value.includes('\0')) throw Error('unsupported text');
  const hasSecrets = maskSecrets(value, 'body').spans.length > 0;
  process.stdout.write(JSON.stringify({ hasSecrets, version: SECRET_PATTERN_VERSION }));
} catch {
  process.exitCode = 1;
}
