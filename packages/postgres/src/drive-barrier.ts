import type { PoolClient } from 'pg';
import { createPool, databaseFailure, type CreatePoolOptions } from './connect.js';

/** Session lock spans I/O, never a transaction; marker fails closed on loss. */
export function driveBarrier(options:CreatePoolOptions) {
  return async function withLock<T>(run:(client:PoolClient)=>Promise<T>):Promise<{ok:true;value:T}|{ok:false;code:'DB_UNAVAILABLE'|'DB_LOCKED';message:string}> {
    const pool=createPool(options); let client:PoolClient|undefined; let locked=false;
    try {
      client=await pool.connect();
      // The session may die while file I/O is pending. Keep the worker alive;
      // the subsequent query fails closed and leaves the durable marker.
      client.on('error',()=>{});
      await client.query("select pg_advisory_lock(hashtextextended('brain:drive-delete-disconnect',0))"); locked=true;
      return {ok:true,value:await run(client)};
    } catch(error) { const failure=databaseFailure(error);return {...failure,message:'Drive 안전 장벽을 확인할 수 없습니다'}; }
    finally {
      if(client){
        try {if(locked)await client.query("select pg_advisory_unlock(hashtextextended('brain:drive-delete-disconnect',0))");client.release();}
        catch {client.release(true);}
      }
      await pool.end().catch(()=>{});
    }
  };
}
export type DriveBarrier = ReturnType<typeof driveBarrier>;
