import { postgresStore } from 'second_brain/postgres';

process.on('message', async message => {
  const store = postgresStore({ databaseUrl: message.databaseUrl });
  if (message.operation === 'insert') {
    const result = await store.createChannelRequest({ ...message.input, createdAt: new Date(message.input.createdAt) });
    process.send({ stage: 'inserted', result });
    return;
  }
  process.send({ stage: 'starting' });
  const result = await store.handoffChannelRequest({ requestId: message.requestId, workId: message.workId, now: new Date(message.now) });
  await store.close();
  process.send({ stage: 'handed', result }, () => process.disconnect());
});
