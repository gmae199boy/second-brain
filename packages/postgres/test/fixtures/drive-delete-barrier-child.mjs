import { unlink } from 'node:fs/promises';
import { postgresStore } from '../../dist/index.js';
process.once('message', async input => {
  const store=postgresStore({databaseUrl:input.url});
  try {
    const at=new Date(input.at);
    const result=await store.withDriveLocalDelete({workId:input.workId,localLocationId:'local',claimedBy:'worker',claimedAt:at,attempts:1,now:at},async()=>{
      process.send('entered');
      await new Promise(resolve=>process.once('message',resolve));
      await unlink(input.file);
      return 'deleted';
    });
    process.send({result});
  } finally { await store.close();process.disconnect(); }
});
