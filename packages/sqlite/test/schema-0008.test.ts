import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';
import { withWrite } from '../src/write.js';
import { writeAttachments } from '../src/attachments.js';

const AT = '2026-01-01T00:00:00.000Z';
const TABLES = ['message_attachments', 'document_extractions', 'document_chunks', 'file_names', 'file_metadata', 'files'];

describe('0008 attachment and extraction change rules', () => {
  let root: string;
  let connection: SqliteConnection;
  const db = () => connection.database;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brain-schema-0008-'));
    const directory = join(root, 'migrations');
    const path = join(root, 'brain.db');
    await mkdir(directory);
    for (const name of await readdir(SQLITE_MIGRATIONS_DIRECTORY)) {
      if (/^000[1-7]_/.test(name)) await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    expect(await runSqliteMigrations({ path, directory })).toMatchObject({ ok: true, to: 7 });
    const opened = openSqlite({ path, busyTimeoutMs: 100 });
    if (!opened.ok) throw new Error(opened.message);
    connection = opened.connection;
    db().exec(`
      insert into users(id,name,is_self,created_at) values('u','owner',1,'${AT}');
      insert into sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source)
        values('s','demo','s','u','machine','${AT}','import');
      insert into messages(id,session_id,harness_message_id,role,body,occurred_at)
        values('m','s','m','user','body','${AT}'),('other','s','other','user','body','${AT}');
      insert into files(id,content_hash,size_bytes,first_seen_at,redacted_at) values
        ('f','sha256:' || printf('%064d',1),1,'${AT}',null),
        ('g','sha256:' || printf('%064d',2),1,'${AT}',null),
        ('r','sha256:' || printf('%064d',3),1,'${AT}','${AT}');
      insert into message_attachments(id,message_id,ordinal,source_kind,source_ref,display_name,file_id,status) values
        ('stored','m',0,'path','/demo/file','file','f','stored'),
        ('missing','m',1,'path',null,null,null,'missing_at_ingest'),
        ('pending','m',2,'path',null,null,null,null),
        ('pending-missing','m',3,'path',null,null,null,null);
      insert into document_extractions(id,file_id,extractor_version,attempt,started_at,status,finished_at,failed_stage) values
        ('open','f','v1',1,'${AT}',null,null,null),
        ('current','f','v1',2,'${AT}','ok','${AT}',null),
        ('failed','f','v1',3,'${AT}','failed','${AT}','extract'),
        ('old','f','v1',4,'${AT}','ok','${AT}',null);
      update files set current_extraction_id='current' where id='f';
      insert into document_chunks(id,extraction_id,ordinal,body,chunk_locator)
        select id,id,0,'body','{"type":"text"}' from document_extractions;
      insert into file_names(id,file_id,name_source,text) values
        ('name','f','attachment_name','file'),('redacted-name','r','attachment_name','legacy');
      insert into file_metadata(id,file_id,key,value) values
        ('meta','f','camera','demo'),('redacted-meta','r','camera','legacy');
    `);
    const before = TABLES.map(table => db().prepare(`select * from ${table} order by id`).all());
    expect(await runSqliteMigrations({ path })).toEqual({
      ok: true, from: 7, to: 8, applied: ['0008_attachment_rules.sql'],
    });
    expect(TABLES.map(table => db().prepare(`select * from ${table} order by id`).all())).toEqual(before);
    expect(db().prepare('pragma foreign_key_check').all()).toEqual([]);
  });
  afterEach(async () => {
    await connection?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('preserves attachment provenance and finalized outcomes, allows first fill and no-op updates', () => {
    for (const change of ["id='changed'", "message_id='other'", 'ordinal=10', "source_kind='inline'", 'source_ref=null', 'display_name=null', "file_id='g'", 'status=null,file_id=null']) {
      expect(() => db().exec(`update message_attachments set ${change} where id='stored'`)).toThrow(/message_attachments/);
    }
    expect(() => db().exec("update message_attachments set status='stored',file_id='f' where id='missing'")).toThrow(/message_attachments/);
    expect(() => db().exec("update message_attachments set source_ref='new' where id='pending'")).toThrow(/message_attachments/);
    for (const id of ['stored', 'missing', 'pending']) {
      expect(() => db().exec(`delete from message_attachments where id='${id}'`)).toThrow(/message_attachments/);
    }
    db().exec("update message_attachments set status='stored',file_id='f' where id='pending'");
    db().exec("update message_attachments set status='missing_at_ingest' where id='pending-missing'");
    db().exec('update message_attachments set status=status,file_id=file_id');
    expect(db().prepare("select status,file_id from message_attachments where id='pending'").get()).toEqual({ status: 'stored', file_id: 'f' });
    expect(() => db().exec("update message_attachments set status=null where id='pending-missing'")).toThrow(/message_attachments/);
  });

  it('allows open-generation progress but freezes identity and every closed-generation field even during redaction', async () => {
    for (const change of ["id='changed'", "file_id='g'", "extractor_version='v2'", 'attempt=10', "started_at='2026-01-02T00:00:00.000Z'"]) {
      expect(() => db().exec(`update document_extractions set ${change} where id='open'`)).toThrow(/document_extractions/);
    }
    expect(() => db().exec("update document_extractions set status='failed',finished_at='" + AT + "' where id='open'")).toThrow(/failed_stage/);
    db().exec("update document_extractions set media_type='text/plain',error='reading' where id='open'");
    db().exec(`update document_extractions set status='failed',finished_at='${AT}',failed_stage='read',error='failed' where id='open'`);
    const refuseClosed = () => {
      for (const id of ['current', 'failed', 'open']) {
        for (const change of ["media_type='other'", "error='changed'", 'status=null,finished_at=null', "finished_at='2026-01-02T00:00:00.000Z'", "failed_stage='index'", "index_config_id='missing'"]) {
          expect(() => db().exec(`update document_extractions set ${change} where id='${id}'`)).toThrow(/document_extractions/);
        }
      }
    };
    refuseClosed();
    await withWrite(connection, async () => { refuseClosed(); }, { redact: true });
    db().exec('update document_extractions set error=error');
  });

  it('deletes chunks only after failure closure, pointer replacement, or with the redaction marker', async () => {
    for (const id of ['open', 'current']) expect(() => db().exec(`delete from document_chunks where id='${id}'`)).toThrow(/document_chunks/);
    db().exec("delete from document_chunks where id='failed'");
    db().exec(`update document_extractions set status='failed',finished_at='${AT}',failed_stage='chunk' where id='open'`);
    db().exec("delete from document_chunks where id='open'");
    db().exec("update files set current_extraction_id='old' where id='f'");
    db().exec("delete from document_chunks where id='current'");
    expect(() => db().exec("delete from document_chunks where id='old'")).toThrow(/document_chunks/);
    expect(await withWrite(connection, async () => { db().exec("delete from document_chunks where id='old'"); }, { redact: true })).toMatchObject({ ok: true });
    expect(connection.isRedactAllowed()).toBe(false);
    expect(db().prepare('select count(*) n from document_chunks').get()?.n).toBe(0);
  });

  it('refuses names and metadata for redacted targets while permitting deletion and regeneration elsewhere', async () => {
    const check = () => {
      for (const table of ['file_names', 'file_metadata']) {
        expect(() => db().exec(`update ${table} set file_id='r' where file_id='f'`)).toThrow(new RegExp(table));
        expect(() => db().exec(`update ${table} set file_id=file_id where file_id='r'`)).toThrow(new RegExp(table));
      }
      expect(() => db().exec("insert into file_names(id,file_id,name_source,text) values('new','r','attachment_name','new')")).toThrow(/file_names/);
      expect(() => db().exec("insert into file_metadata(id,file_id,key,value) values('new','r','key','value')")).toThrow(/file_metadata/);
    };
    check();
    await withWrite(connection, async () => { check(); }, { redact: true });
    db().exec(`
      delete from file_names; delete from file_metadata;
      insert into file_names(id,file_id,name_source,text) values('name','f','attachment_name','rebuilt');
      insert into file_metadata(id,file_id,key,value) values('meta','f','camera','rebuilt');
      update file_names set text='renamed' where id='name';
      update file_metadata set value='updated' where id='meta';
    `);
    expect(db().prepare('select text from file_names').get()?.text).toBe('renamed');
    expect(db().prepare('select value from file_metadata').get()?.value).toBe('updated');
  });

  it('keeps the 10.2 attachment write path idempotent on schema 8', async () => {
    const attachments = [{
      id: 'retry', harnessMessageId: 'm', ordinal: 9, sourceKind: 'path', sourceRef: '/demo/new', displayName: 'new',
      file: { id: 'new-file', contentHash: 'sha256:' + 'a'.repeat(64), sizeBytes: 2,
        location: { id: 'new-location', storeKind: 'local' as const, locator: '/demo/new', ownership: 'brain' as const } },
    }];
    const write = () => withWrite(connection, held => writeAttachments(held, attachments, new Map([['m', 'm']]), AT));
    expect(await write()).toEqual({ ok: true, value: 1 });
    expect(await write()).toEqual({ ok: true, value: 0 });
    expect(db().prepare("select status,file_id from message_attachments where id='retry'").get()).toEqual({ status: 'stored', file_id: 'new-file' });
  });
});
