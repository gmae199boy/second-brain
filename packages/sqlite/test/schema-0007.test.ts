import { copyFile, mkdtemp, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';

it('0007은 기존 꼬리표와 행을 보존하고 근거 불변을 강제한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-schema-0007-'));
  const directory = join(root, 'migrations');
  const path = join(root, 'brain.db');
  try {
    await mkdir(directory);
    for (const name of await readdir(SQLITE_MIGRATIONS_DIRECTORY)) {
      if (/^000[1-6]_/.test(name)) await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    expect(await runSqliteMigrations({ path, directory })).toMatchObject({ ok: true, to: 6 });
    let db = new DatabaseSync(path);
    try {
      db.exec(`
        pragma foreign_keys = on;
        insert into users(id,name,is_self,created_at) values('u','brain-owner',1,'2026-01-01T00:00:00.000Z');
        insert into projects(id,remote_identity,identity_key) values('p','demo.example/brain-owner/notes','demo.example/brain-owner/notes');
        insert into worktrees(id,project_id,path) values('w','p','/demo/repo');
        insert into sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source,project_id,worktree_id)
          values('tagged','demo','tagged','u','demo-machine','2026-01-01T00:00:00.000Z','import','p','w'),
                ('empty','demo','empty','u','demo-machine','2026-01-01T00:00:00.000Z','import',null,null);
      `);
    } finally { db.close(); }
    expect(await runSqliteMigrations({ path })).toEqual({ ok: true, from: 6, to: 9, applied: ['0007_session_tag_source.sql', '0008_attachment_rules.sql', '0009_schedules.sql'] });
    db = new DatabaseSync(path);
    try {
      expect(db.prepare('select id,project_id,worktree_id,tag_source,first_cwd from sessions order by id').all()).toEqual([
        { id: 'empty', project_id: null, worktree_id: null, tag_source: null, first_cwd: null },
        { id: 'tagged', project_id: 'p', worktree_id: 'w', tag_source: 'cwd', first_cwd: null },
      ]);
      expect(db.prepare('select count(*) n from projects').get()?.n).toBe(1);
      expect(db.prepare('select count(*) n from worktrees').get()?.n).toBe(1);
      db.exec("update sessions set first_cwd='/demo/gone' where id='empty'");
      for (const query of [
        "update sessions set first_cwd='/demo/other' where id='empty'",
        "update sessions set first_cwd=null where id='empty'",
        "update sessions set tag_source='sibling' where id='tagged'",
        "update sessions set tag_source=null where id='tagged'",
        "update sessions set tag_source='invalid' where id='empty'",
        "update sessions set tag_source='cwd' where id='empty'",
        "update sessions set project_id='p',worktree_id='w' where id='empty'",
      ]) expect(() => db.exec(query)).toThrow();
      db.exec("update sessions set project_id='p',worktree_id='w',tag_source='ancestor' where id='empty'");
      expect(db.prepare("select first_cwd,tag_source from sessions where id='empty'").get()).toEqual({ first_cwd: '/demo/gone', tag_source: 'ancestor' });
      expect(() => db.exec(`insert into sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source,tag_source)
        values('bad','demo','bad','u','demo-machine','2026-01-01T00:00:00.000Z','import','sibling')`)).toThrow();
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
