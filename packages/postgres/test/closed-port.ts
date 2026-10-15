import { createServer } from 'node:net';

/**
 * A TCP port nothing listens on, so connecting is refused immediately.
 *
 * It is found by listening on an ephemeral port and letting it go again, which
 * is the one way to get a port the operating system has just confirmed is free.
 * Both the store and the migration tests need it to check what a connection
 * that cannot be made reports, so it lives here rather than in either of them.
 */
export async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
