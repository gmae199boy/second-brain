-- Keep the original tagging evidence after a transcript disappears.
-- Triggers preserve references to sessions without rebuilding the table.
alter table sessions add column tag_source text;
alter table sessions add column first_cwd text;

update sessions set tag_source = 'cwd' where project_id is not null;

create trigger sessions_tag_evidence_insert before insert on sessions
when (new.tag_source is not null and new.tag_source not in ('cwd', 'ancestor', 'sibling'))
  or ((new.tag_source is null) != (new.project_id is null))
begin
  select raise(abort, '세션 꼬리표 출처가 올바르지 않습니다');
end;

create trigger sessions_tag_evidence_update before update on sessions
when (new.tag_source is not null and new.tag_source not in ('cwd', 'ancestor', 'sibling'))
  or ((new.tag_source is null) != (new.project_id is null))
  or (old.tag_source is not null and new.tag_source is not old.tag_source)
  or (old.first_cwd is not null and new.first_cwd is not old.first_cwd)
begin
  select raise(abort, '세션 꼬리표 근거는 바꿀 수 없습니다');
end;
