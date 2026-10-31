import { createPool } from './connect.js';

/** 설치 잠금은 세션에 묶으며 대기 중 취소는 잠금 소유자에 영향을 주지 않는다. */
export async function withExtensionInstallLock<T>(databaseUrl: string, name: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const pool = createPool({ databaseUrl, lockTimeoutMs: 0, queryTimeoutMs: 0 });
  let client; let held = false;
  const cancelled = () => Object.assign(new Error('확장 설치 잠금 대기가 취소되었습니다'), { code: 'EXTENSION_INSTALL_CANCELLED' });
  try {
    if (signal?.aborted) throw cancelled();
    client = await pool.connect();
    while (!held) {
      if (signal?.aborted) throw cancelled();
      const result = await client.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [`extension-install:${name}`]);
      held = result.rows[0]?.acquired === true;
      if (signal?.aborted) throw cancelled();
      if (!held) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 100);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
    return await run();
  } finally {
    try {
      if (client) { try { if (held) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [`extension-install:${name}`]); } finally { client.release(); } }
    } finally { await pool.end(); }
  }
}
