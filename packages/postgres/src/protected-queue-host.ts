import { createPool, type CreatePoolOptions } from './connect.js';

/** 보호 supervisor 전용. DB 실패와 불명 commit은 모두 닫힌 결과다. */
export function postgresQueueHostFence(options: CreatePoolOptions) {
  const pool=createPool({...options,lockTimeoutMs:1000,queryTimeoutMs:2000});
  return {
    async begin(token: string): Promise<boolean> {
      try {const result=await pool.query('select brain.begin_queue_host($1::uuid) as ok',[token]);return result.rows[0]?.ok===true;} catch {return false;}
    },
    async settle(token: string, confirmed: boolean): Promise<boolean> {
      try {const result=await pool.query('select brain.settle_queue_host($1::uuid,$2::boolean) as ok',[token,confirmed]);return result.rows[0]?.ok===true;} catch {return false;}
    },
    async close(): Promise<void> {await pool.end();},
  };
}
