-- 응답 유실 복구용 내부 결과다. 사용자 데이터 API에는 노출하지 않는다.
create table brain.protected_mutation_receipts (
 id uuid primary key, action text not null, scope text not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
revoke all on brain.protected_mutation_receipts from public,brain_app;
grant select,insert on brain.protected_mutation_receipts to brain_protected_supervisor;
