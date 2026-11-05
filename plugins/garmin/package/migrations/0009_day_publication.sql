-- Dirty generations survive raw commits; reservations are shared across versions.
alter table garmin.normalize_items add column null_materialized boolean not null default true;
-- 0008 did not record whether a successful null had an existing target row.
-- Conservatively revisit it once when a target exists; immutable inserts are idempotent.
update garmin.normalize_items set null_materialized=false
 where ok and (revision='74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'
   or revision like '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b:%');
create table garmin.normalize_day_dirty (
 dataset text not null references garmin.datasets(dataset), day date not null,
 generation bigint not null, completed_generation bigint not null default 0,
 primary key(dataset,day)
);
create table garmin.normalize_day_revisions (
 dataset text not null references garmin.datasets(dataset), day date not null,
 revision text not null, base_revision text not null, source_max_ms bigint not null, watermark_us bigint not null,
 primary key(dataset,day,revision)
);
insert into garmin.normalize_day_revisions(dataset,day,revision,base_revision,source_max_ms,watermark_us)
 select dataset,day,revision,revision,min(fetched_at_ms),min(fetched_at_ms)*1000
 from garmin.normalize_days group by dataset,day,revision;
grant select, insert, update on garmin.normalize_day_dirty, garmin.normalize_day_revisions to brain_ext_garmin;
