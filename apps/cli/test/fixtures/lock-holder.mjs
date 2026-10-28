// Hold PostgreSQL tables in another process so hook/drain lock budgets are real.
import pg from 'pg';
const client = new pg.Client({ connectionString: process.argv[2] });
await client.connect();
await client.query('begin');
await client.query('lock table brain.sessions in share mode');
process.stdout.write('held\n');
setTimeout(async () => {
  await client.query('rollback'); await client.end(); process.stdout.write('released\n');
}, Number(process.argv[3]));
