-- 설치 전에도 기록할 수 있으며 기존 registry와 별개의 사실이다.
create table brain.extension_install_progress (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,30}$' and name !~ '^(core|brain|public|pg_)'),
  revision integer not null check (revision > 0),
  progress jsonb not null check (jsonb_typeof(progress) = 'object' and progress->>'name' = name)
);
revoke all on brain.extension_install_progress from public;
grant select, insert, update on brain.extension_install_progress to brain_app;
