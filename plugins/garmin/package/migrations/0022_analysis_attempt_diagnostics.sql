-- Only fixed classifications and byte counts; no model text or health values.
create table garmin.analysis_attempt_diagnostics (
 work_id uuid not null, report_date text not null,
 scope text not null check(scope in ('day','7d','30d','all')),
 attempt integer not null check(attempt between 1 and 6),
 started_at timestamptz not null default clock_timestamp(),
 ended_at timestamptz, elapsed_ms bigint check(elapsed_ms >= 0),
 error_code text not null default 'IN_PROGRESS'
   check(error_code ~ '^[A-Za-z_]+$'),
 terminal boolean not null default false,
 input_bytes bigint not null default 0 check(input_bytes >= 0),
 output_bytes bigint not null default 0 check(output_bytes >= 0),
 event_bytes bigint not null default 0 check(event_bytes >= 0),
 primary key(work_id,report_date,scope,attempt)
);
