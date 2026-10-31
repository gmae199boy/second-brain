-- 수집 성공의 불변 기록. 기존 반입 dataset과 별개로 보관한다.
create table garmin.collect_state (
 dataset text not null references garmin.datasets(dataset),
 account text not null, day date not null, endpoint text not null,
 revision text not null, fetched_at_ms bigint not null,
 primary key (dataset, day, endpoint)
);
