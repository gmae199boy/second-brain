-- 수동 기간 분석은 일일 평가의 scope·revision 공간을 사용하지 않는다.
create table garmin.period_evaluations (
 user_id uuid not null, connection_id uuid not null,
 start_date text not null, end_date text not null, revision bigint not null check(revision>0),
 work_id uuid not null unique, focus jsonb not null,
 summary text not null, report_md text not null,
 judgments jsonb not null, evidence jsonb not null, next_checks jsonb not null,
 model text not null, created_at bigint not null,
 primary key(user_id,connection_id,start_date,end_date,revision),
 foreign key(user_id,connection_id) references garmin.account_connections(user_id,connection_id),
 check(start_date<=end_date)
);
create trigger period_evaluations_immutable before update or delete on garmin.period_evaluations
 for each row execute function garmin.reject_native_mutation();
