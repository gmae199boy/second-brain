-- The sixth migration of the source of truth: the message number goes away,
-- and conversation order becomes the one thing a message already carried --
-- `occurred_at` (AD-4, AD-8, AD-14, AD-15, Table Contract).
--
-- `messages.seq` was doing two jobs that want opposite things. As an address --
-- what a chunk range and a log join pointed at -- it may never move. As the
-- reading order it has to let a message that arrives late sit where it belongs.
-- A store that assigns `max(seq) + 1` cannot do both: a parser version that
-- starts keeping a line from the middle of a conversation gives that message
-- the highest number there is, and it is then read at the end of a conversation
-- it happened in the middle of.
--
-- So the number is removed rather than fixed, and nothing replaces it. The
-- order a reader wants is the order the messages were uttered in, which is
-- already stored, measured, and does not depend on when a batch arrived: over
-- the 236 transcripts on the machine this was decided on, the messages the
-- current parser keeps gave 6,927 adjacent pairs with 0 going backwards in time
-- and 0 sharing a millisecond (Design Notes of story 2.24, 2026-10-20). The
-- order of two messages at the same instant is deliberately left undefined --
-- a tie-break column would be the address problem again, under a new name.
--
-- Three tables follow from that:
--
--   * `messages` loses the column and the `(session_id, seq)` key. Its
--     identity is `(session_id, harness_message_id)` alone, which is what the
--     harness itself calls the message, so a compact or a fork that rewrites
--     the front of a transcript still cannot turn one stored message into
--     another.
--   * `log_entries` loses `anchor_seq` and `joined_upto_seq`. A log line sits
--     at its own `occurred_at` and the link to a message is not stored at all,
--     so there is nothing for a late message to invalidate and no drain job to
--     re-join anything (AD-14).
--   * `chunks` carries the instants of its first and last message, `from_at`
--     and `to_at`, instead of their numbers, and is keyed on them (AD-15).
--
-- `0001_initial.sql` through `0005_identity_and_records.sql` are not touched
-- and never will be: migrations go forward only (Conventions), and a file that
-- has been applied on somebody's machine cannot be edited into a different
-- schema. 0001 and 0004 therefore go on spelling `seq` -- that is the history
-- of the column, not a live rule.
--
-- The spelling rules are 0001's: every ordinary table is `STRICT`, ids are
-- `text` holding a UUIDv7 (AD-8), instants are `text` in the one canonical
-- 24-character spelling pinned by a `glob` check (AD-13), and a boolean is
-- `integer` with `check (x in (0, 1))`.
--
-- `messages` and `chunks` are stashed, dropped and rebuilt the way 0004 and
-- 0005 rebuilt theirs: SQLite can drop a column but it cannot drop a key or a
-- `check`, and both tables lose one. `log_entries` is the opposite case and
-- gets `alter table ... drop column` instead -- it carries the external-content
-- FTS5 index `log_entries_fts`, which finds its rows by `search_rowid`, and a
-- rebuild that renumbered one row would point the index at another. Dropping
-- two columns no index and no trigger mentions leaves every `search_rowid`
-- where it was.
--
-- `pragma defer_foreign_keys` is what makes the `messages` rebuild legal:
-- `redactions` and `message_attachments` both point at `messages (id)`, and
-- with foreign keys enforced immediately the `drop` would be refused on the
-- spot. Deferred, the check happens at commit -- by which time the rows are
-- back under the same ids. The pragma lasts for this transaction only and
-- resets itself at commit; it is not `foreign_keys = OFF`, which would skip the
-- check altogether rather than postpone it.
--
-- It is a drop and not an `alter table ... rename`, for 0004's reason: with
-- `legacy_alter_table` off -- the default, and what `node:sqlite` gives us -- a
-- rename rewrites the foreign key clauses of every table that referred to the
-- old name, so `message_attachments` would come out of it pointing at
-- `messages_old`.
--
-- Postgres is a replica of this schema (AD-22) and is behind by 0004 and 0005
-- already; it catches up in epic 7, which is where this file follows too.
pragma defer_foreign_keys = ON;

-- `chunks` comes first, before `messages` loses the column: the instants this
-- table now stores are read *out of* `messages.seq`, so the copy below has to
-- happen while that column still exists.
--
-- Two instants instead of two numbers (AD-15). A chunk covers a stretch of one
-- session's conversation, and the stretch is now named by when it starts and
-- when it ends -- the `occurred_at` of its first and last message. That is what
-- lets a message that arrives late fall inside the chunk it belongs to:
-- `from_at <= occurred_at <= to_at` is a question about the conversation, while
-- `seq_from <= seq <= seq_to` was a question about insertion order.
--
-- Neither the key nor the `check`s can be altered, so the table is stashed,
-- dropped and rebuilt. `search_rowid` is carried across unchanged, which is the
-- whole reason the copy is written out rather than left to a fresh numbering:
-- `chunks_fts` is an external-content index that finds its rows by that number,
-- `drop table` does not fire the delete trigger that would have told it
-- anything, and a renumbered row would silently answer searches as another one.
--
-- `from_at <= to_at` is the one ordering rule left: a chunk cannot end before
-- it starts. Equality is allowed, because a chunk may be a single message.
create temp table chunks_stash as select * from chunks;

drop table chunks;

create table chunks (
  search_rowid integer primary key,
  id text not null unique,
  session_id text not null references sessions (id),
  index_config_id text not null references index_configs (id),
  from_at text not null,
  to_at text not null,
  body text not null,
  unique (session_id, index_config_id, from_at, to_at),
  constraint chunks_from_at_check
    check (from_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint chunks_to_at_check
    check (to_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint chunks_range_check check (from_at <= to_at)
) strict;

-- Each stashed row's two numbers become the two instants of the messages they
-- named, in the same session.
--
-- In practice the stash is empty: nothing writes `chunks` yet, drain's indexing
-- arrives later (AD-15). The copy is here because a schema step that only works
-- on an empty table is a step nobody can trust on the one database that turns
-- out not to be -- a row somebody inserted by hand while developing is still a
-- row, and losing it quietly would be worse than refusing it loudly.
--
-- `left join`, not `join`, deliberately: a chunk naming a `seq` no message of
-- that session has is a chunk about nothing, and under a `left join` the null
-- it produces is refused by `not null` and takes the whole migration down with
-- it. An inner join would have dropped the row without a word, and nothing in
-- this schema can write such a row in the first place, so it would be a bug
-- being hidden.
--
-- `min` and `max` and not the two columns in order, because the numbers and
-- the instants can disagree -- which is the whole reason this file exists. The
-- lower `seq` is the message the store happened to insert first, and that can
-- be the later moment, so copying `seq_from`'s instant straight into `from_at`
-- would hand `chunks_range_check` a range that ends before it starts and
-- refuse an upgrade over a row that says nothing wrong. The pair is a stretch
-- of conversation; which end was numbered first is not part of it. A null from
-- the `left join` still wins: SQLite's `min`/`max` of two values answer null
-- when either argument is null, so a missing message is refused exactly as
-- before.
insert into chunks (search_rowid, id, session_id, index_config_id, from_at, to_at, body)
     select stashed.search_rowid, stashed.id, stashed.session_id, stashed.index_config_id,
            min(first.occurred_at, last.occurred_at),
            max(first.occurred_at, last.occurred_at),
            stashed.body
       from chunks_stash stashed
       left join messages first
         on first.session_id = stashed.session_id
        and first.seq = stashed.seq_from
       left join messages last
         on last.session_id = stashed.session_id
        and last.seq = stashed.seq_to;

drop table chunks_stash;

-- The three FTS triggers went with the dropped table and come back word for
-- word from 0001: the index holds the terms, the table holds the text, and
-- every write to `body` is mirrored in the same transaction (AD-11, AD-15).
--
-- They are created *after* the copy above and not before it. A trigger already
-- in place would have had the copy insert every carried-over row into
-- `chunks_fts` a second time, under a rowid the index already holds.
create trigger chunks_fts_ai after insert on chunks begin
  insert into chunks_fts(rowid, body) values (new.search_rowid, new.body);
end;

create trigger chunks_fts_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, body) values ('delete', old.search_rowid, old.body);
end;

create trigger chunks_fts_au after update of body on chunks begin
  insert into chunks_fts(chunks_fts, rowid, body) values ('delete', old.search_rowid, old.body);
  insert into chunks_fts(rowid, body) values (new.search_rowid, new.body);
end;

-- The log–message link is not stored any more (AD-14). A log line records when
-- it was written, and that instant is the whole of its place in the
-- conversation: the messages around it are the ones either side of that
-- instant, read at the moment somebody asks. `anchor_seq` was the answer
-- cached, and `joined_upto_seq` was how far the messages had been read when
-- that answer was worked out -- a pair that only existed so a later message
-- could invalidate it and a drain job could compute it again. With no stored
-- answer there is nothing to invalidate and no job to run.
--
-- Both are dropped in place rather than by a rebuild: see the header on
-- `log_entries_fts` and `search_rowid`. Neither column is in a key, an index, a
-- `check` or a trigger body, which is what makes `drop column` legal here at
-- all.
alter table log_entries drop column anchor_seq;
alter table log_entries drop column joined_upto_seq;

-- Conversation messages, with no number of their own (AD-4, AD-8). Immutable,
-- with `messages.redact` as the one exception (AD-11).
--
-- The column goes and so does `unique (session_id, seq)`, and SQLite can drop
-- neither a key nor a column inside one, so the table is stashed, dropped and
-- rebuilt. What is left is the identity the harness gave the message:
-- `(session_id, harness_message_id)` is the only key, and it is the only thing
-- an insert may conflict on.
--
-- Everything else is 0001's and 0004's, carried over unchanged -- the role and
-- instant `check`s, the branch as the line carried it, and the subagent-report
-- mark as the integer SQLite stores a boolean in. `is_subagent_report` keeps
-- its `default 0` even though no `alter table` needs one here: a message nobody
-- has looked at is not a report, and that is as true of a row written by hand
-- as of one 0004 back-filled.
create temp table messages_stash as select * from messages;

drop table messages;

create table messages (
  id text primary key,
  session_id text not null references sessions (id),
  harness_message_id text not null,
  role text not null,
  model text,
  body text not null,
  occurred_at text not null,
  git_branch text,
  is_subagent_report integer not null default 0,
  unique (session_id, harness_message_id),
  constraint messages_role_check check (role in ('user', 'assistant')),
  constraint messages_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint messages_is_subagent_report_check check (is_subagent_report in (0, 1))
) strict;

-- Every row comes back under its own id, body and instant. Only the number is
-- left behind, and nothing is computed: the order these rows are read in from
-- here on is the `occurred_at` each of them already carried.
insert into messages (id, session_id, harness_message_id, role, model, body,
                      occurred_at, git_branch, is_subagent_report)
     select id, session_id, harness_message_id, role, model, body,
            occurred_at, git_branch, is_subagent_report
       from messages_stash;

drop table messages_stash;

-- What the reading order is made of, as an index (AD-8, Conventions: indexes
-- are SQL too). Reading a session hands its messages back in conversation
-- order -- `where session_id = ? order by occurred_at` -- and this index is
-- that query, column for column, so the rows come off it already sorted
-- instead of through a temporary B-tree.
--
-- It is not what the cursor guard uses: that one looks two messages up by
-- `harness_message_id` and is answered by the `(session_id,
-- harness_message_id)` unique index, as it was before this file.
--
-- There was no index to replace: `unique (session_id, seq)` was the one that
-- happened to answer the ordering question, and it went with the column.
create index messages_session_occurred_idx on messages (session_id, occurred_at);

-- The two immutability triggers went with the dropped table and come back as
-- 0004 wrote them, minus the one column that no longer exists. The message is
-- deliberately the same one, down to the wording: what it says is still true,
-- and a caller that matched on the sentence is matching on the rule and not on
-- this migration.
--
-- It is written as the list of columns that may *not* move, so a redaction can
-- change `body` and nothing else, and only while the redact marker is raised
-- (AD-11).
create trigger messages_immutable_update
  before update on messages
  when not (brain_redact_allowed() = 1
            and new.id is old.id
            and new.session_id is old.session_id
            and new.harness_message_id is old.harness_message_id
            and new.role is old.role
            and new.model is old.model
            and new.occurred_at is old.occurred_at
            and new.git_branch is old.git_branch
            and new.is_subagent_report is old.is_subagent_report)
begin
  select raise(abort,
    'messages is immutable: an update is refused unless a redaction is in progress and changes body alone');
end;

create trigger messages_immutable_delete
  before delete on messages
begin
  select raise(abort, 'messages is immutable: delete is refused');
end;
