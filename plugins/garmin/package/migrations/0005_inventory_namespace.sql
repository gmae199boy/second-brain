-- 기존 evaluation 제외 행은 고정 metadata 모양으로 구별한다.
-- 원래 키와 batch를 보존하면서 원본 표 namespace를 부여한다.
alter table garmin.artifact_inventory add column original_table text not null default 'artifact';
update garmin.artifact_inventory set original_table='evaluation'
 where category='report' and exclusion_reason='too_large'
   and request_id is null and analysis_id is null and metadata_raw is null
   and metadata = jsonb_build_object('original_table','evaluation','original_key',metadata->>'original_key')
   and artifact_key = 'evaluation:' || (metadata->>'original_key');
alter table garmin.artifact_inventory drop constraint artifact_inventory_pkey;
alter table garmin.artifact_inventory add primary key(dataset,original_table,artifact_key);
alter table garmin.artifact_inventory add constraint artifact_inventory_original_table_check check (original_table in ('artifact','evaluation'));
