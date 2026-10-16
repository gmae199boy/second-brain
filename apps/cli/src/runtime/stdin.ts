/**
 * Everything on standard input, as text. A hook payload is the only thing this
 * CLI ever reads from there — every positional argument is an id (AD-5).
 *
 * A terminal answers with the empty string at once, and that is the whole point
 * of the check: `process.stdin` attached to a TTY never ends on its own, so a
 * person who typed `brain sessions ingest claude-code` by hand would otherwise
 * sit at a blank line with no prompt, waiting for a Ctrl-D nobody told them
 * about. Empty is what the hook reader turns into a `USAGE` naming stdin.
 *
 * It is read lazily, by the command that needs it: a read command that opened
 * the stream would wait on a pipe nobody is writing to.
 */
export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY === true) return '';

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
