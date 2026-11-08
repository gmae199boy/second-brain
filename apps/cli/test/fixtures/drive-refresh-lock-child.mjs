import { withDriveRefreshLock } from '../../dist/config/codec.js';
process.once('message', async ({home}) => {
  await withDriveRefreshLock(home, async () => {
    const keepAlive = setInterval(() => {}, 1000);
    process.send('held');
    try { await new Promise(() => {}); } finally { clearInterval(keepAlive); }
  });
});
