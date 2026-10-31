alter table brain.health_authority_rules add column source_work_item_id uuid references brain.work_items(id), add column source_attempt_token uuid;
alter table brain.health_authority_rules enable row level security;
create policy authority_app on brain.health_authority_rules to brain_app using (true) with check (true);
create policy authority_extension on brain.health_authority_rules for insert with check (current_user = 'brain_ext_' || source);
create trigger authority_attempt before insert on brain.health_authority_rules for each row
 when (session_user like 'brain\_ext\_%' escape '\' or new.source_work_item_id is not null or new.source_attempt_token is not null)
 execute function brain.guard_import_attempt();
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant insert (id,source,account,metric,activity_id,date_from,date_to,revision,datasets,source_work_item_id,source_attempt_token) on brain.health_authority_rules to %I',r.rolname);
 end loop;
end $$;
