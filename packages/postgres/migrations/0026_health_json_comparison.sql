-- 원래 JSON 문자열을 UTF-16 코드 단위의 ASCII로 바꿔 구조와 값을 비교한다.
create function brain.health_json_comparison(display jsonb, raw bytea, encoding text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
 bytes bytea; label text; source text := ''; transformed text := ''; token text;
 i integer; n integer; u integer; v integer; cp integer; c text; esc text; inside boolean := false;
 parsed jsonb;
begin
 if display is null and raw is null then return null; end if;
 if raw is null then bytes := convert_to(display::text,'UTF8'); label := 'utf-8';
 else bytes := raw; label := encoding; end if;
 if label = 'utf-8' then
  source := convert_from(bytes,'UTF8');
 elsif label in ('utf-16le','utf-16be') then
  n := length(bytes); i := 0;
  if n % 2 <> 0 then raise exception 'invalid encoding'; end if;
  while i < n loop
   if label='utf-16le' then u := get_byte(bytes,i) + get_byte(bytes,i+1)*256;
   else u := get_byte(bytes,i)*256 + get_byte(bytes,i+1); end if;
   i := i + 2;
   if u between 55296 and 56319 then
    if i >= n then raise exception 'invalid encoding'; end if;
    if label='utf-16le' then v := get_byte(bytes,i) + get_byte(bytes,i+1)*256;
    else v := get_byte(bytes,i)*256 + get_byte(bytes,i+1); end if;
    if v not between 56320 and 57343 then raise exception 'invalid encoding'; end if;
    i := i + 2; cp := 65536 + (u-55296)*1024 + v-56320;
   elsif u between 56320 and 57343 then raise exception 'invalid encoding';
   else cp := u; end if;
   source := source || chr(cp);
  end loop;
 else raise exception 'invalid encoding'; end if;
 i := 1; n := char_length(source);
 while i <= n loop
  c := substr(source,i,1);
  if not inside then
   if c='"' then inside := true; transformed := transformed || '"u';
   else transformed := transformed || c; end if;
  elsif c='"' then
   inside := false; transformed := transformed || '"';
  elsif c=chr(92) then
   i := i + 1; if i > n then raise exception 'invalid escape'; end if;
   esc := substr(source,i,1);
   if esc='u' then
    token := substr(source,i+1,4);
    if token !~ '^[0-9a-fA-F]{4}$' then raise exception 'invalid escape'; end if;
    transformed := transformed || lower(token); i := i+4;
   else
    u := case esc when '"' then 34 when chr(92) then 92 when '/' then 47 when 'b' then 8 when 'f' then 12 when 'n' then 10 when 'r' then 13 when 't' then 9 else null end;
    if u is null then raise exception 'invalid escape'; end if;
    transformed := transformed || lpad(to_hex(u),4,'0');
   end if;
  else
   cp := ascii(c); if cp < 32 then raise exception 'invalid string'; end if;
   if cp <= 65535 then transformed := transformed || lpad(to_hex(cp),4,'0');
   else cp := cp - 65536; transformed := transformed || lpad(to_hex(55296 + cp / 1024),4,'0') || lpad(to_hex(56320 + cp % 1024),4,'0'); end if;
  end if;
  i := i + 1;
 end loop;
 if inside then raise exception 'invalid string'; end if;
 parsed := transformed::jsonb;
 if jsonb_typeof(parsed) not in ('object','array') then raise exception 'invalid json'; end if;
 return jsonb_build_array('json',parsed);
exception when others then
 return jsonb_build_array('invalid',label,encode(bytes,'hex'));
end $$;
grant execute on function brain.health_json_comparison(jsonb,bytea,text) to brain_app;
-- 원문 인코딩은 보관하고 유효 문자열의 논리 코드 단위만 비교한다.
create function brain.health_text_comparison(display text, raw bytea, encoding text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare bytes bytea; label text; result text := ''; segment bytea := ''::bytea; decoded text;
 i integer := 0; j integer; n integer; u integer; v integer; cp integer; b integer;
begin
 if display is null and raw is null then return null; end if;
 if raw is null then bytes := convert_to(display,'UTF8'); label := 'utf-8';
 else bytes := raw; label := encoding; end if;
 n := length(bytes);
 if label = 'utf-8' then
  while i <= n loop
   b := case when i=n then 0 else get_byte(bytes,i) end;
   if b=0 then
    decoded := convert_from(segment,'UTF8');
    for j in 1..char_length(decoded) loop
     cp := ascii(substr(decoded,j,1));
     if cp <= 65535 then result := result || lpad(to_hex(cp),4,'0');
     else cp := cp-65536; result := result || lpad(to_hex(55296+cp/1024),4,'0') || lpad(to_hex(56320+cp%1024),4,'0'); end if;
    end loop;
    if i<n then result := result || '0000'; end if;
    segment := ''::bytea;
   else segment := segment || substring(bytes from i+1 for 1); end if;
   i := i+1;
  end loop;
 elsif label in ('utf-16le','utf-16be') then
  if n%2<>0 then raise exception 'invalid encoding'; end if;
  while i<n loop
   if label='utf-16le' then u := get_byte(bytes,i)+get_byte(bytes,i+1)*256;
   else u := get_byte(bytes,i)*256+get_byte(bytes,i+1); end if;
   i := i+2;
   if u between 55296 and 56319 then
    if i>=n then raise exception 'invalid encoding'; end if;
    if label='utf-16le' then v := get_byte(bytes,i)+get_byte(bytes,i+1)*256;
    else v := get_byte(bytes,i)*256+get_byte(bytes,i+1); end if;
    if v not between 56320 and 57343 then raise exception 'invalid encoding'; end if;
    result := result || lpad(to_hex(u),4,'0') || lpad(to_hex(v),4,'0'); i := i+2;
   elsif u between 56320 and 57343 then raise exception 'invalid encoding';
   else result := result || lpad(to_hex(u),4,'0'); end if;
  end loop;
 else raise exception 'invalid encoding'; end if;
 return jsonb_build_array('text',result);
exception when others then return jsonb_build_array('invalid',label,encode(bytes,'hex'));
end $$;
grant execute on function brain.health_text_comparison(text,bytea,text) to brain_app;
create or replace view brain.health_resolution_v1 as
with keys as (
 select distinct source,account,metric,activity_id,sub_identity,local_date,observed_at,time_zone,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')) as account_identity,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')) as activity_id_identity,(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')) as sub_identity_identity from brain.health_observations h
), decisions as (
 select k.*, a.id as authority_id,a.revision as authority_version,a.datasets,
   (select count(distinct h.dataset) from brain.health_observations h where (h.source,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')),h.metric,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')),(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')),h.local_date,h.observed_at,h.time_zone) is not distinct from (k.source,k.account_identity,k.metric,k.activity_id_identity,k.sub_identity_identity,k.local_date,k.observed_at,k.time_zone)) as dataset_count,
   (select bool_and(h.account_confirmed) from brain.health_observations h where (h.source,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')),h.metric,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')),(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')),h.local_date,h.observed_at,h.time_zone) is not distinct from (k.source,k.account_identity,k.metric,k.activity_id_identity,k.sub_identity_identity,k.local_date,k.observed_at,k.time_zone)) as confirmed,
   (select array_agg(h.id order by h.id) from brain.health_observations h where (h.source,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')),h.metric,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')),(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')),h.local_date,h.observed_at,h.time_zone) is not distinct from (k.source,k.account_identity,k.metric,k.activity_id_identity,k.sub_identity_identity,k.local_date,k.observed_at,k.time_zone)) as all_ids
 from keys k left join lateral (
   select r.* from brain.health_authority_rules r where r.source=k.source and (coalesce(r.account_encoding,'utf-8') || ':' || encode(coalesce(r.account_raw,convert_to(r.account,'UTF8')),'hex'))=k.account_identity and (r.metric is null or r.metric=k.metric) and (r.activity_id is null or (coalesce(r.activity_id_encoding,'utf-8') || ':' || encode(coalesce(r.activity_id_raw,convert_to(r.activity_id,'UTF8')),'hex'))=k.activity_id_identity) and (r.date_from is null or k.local_date>=r.date_from) and (r.date_to is null or k.local_date<=r.date_to)
   order by ((r.metric is not null)::int+(r.activity_id is not null)::int+(r.date_from is not null)::int+(r.date_to is not null)::int) desc,r.revision desc,r.id limit 1
 ) a on true
), selected_dataset as (
 select d.*, case when d.authority_id is null and d.dataset_count=1 then
   (select h.dataset from brain.health_observations h where h.id=d.all_ids[1])
 else (select x.dataset from unnest(d.datasets) with ordinality x(dataset,ord) where exists(select 1 from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=x.dataset) order by x.ord limit 1) end as dataset
 from decisions d
), latest as (
 select d.*, (select max(h.fetched_at) from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=d.dataset) as fetched_at from selected_dataset d
), revisions as (
 select d.*, (select count(distinct h.revision) from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=d.dataset and h.fetched_at=d.fetched_at) as revision_count,
 (select array_agg(h.id order by h.id) from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=d.dataset and h.fetched_at=d.fetched_at) as observed_ids,
 (select max(h.normalization_version) from brain.health_observations h join brain.health_supported_versions v on v.version=h.normalization_version where h.id=any(d.all_ids) and h.dataset=d.dataset and h.fetched_at=d.fetched_at) as version
 from latest d
), candidates as (
 select d.*, (select array_agg(h.id order by h.id) from brain.health_observations h where h.id=any(d.observed_ids) and h.normalization_version=d.version) as candidate_ids,
 (select count(distinct jsonb_build_array(h.value_type,h.value,brain.health_text_comparison(h.value_text,h.value_text_raw,h.value_text_encoding),brain.health_json_comparison(h.value_json,h.value_json_raw,h.value_json_encoding))) from brain.health_observations h where h.id=any(d.observed_ids) and h.normalization_version=d.version) as value_count from revisions d
), reasons as (
 select d.*, case when account is null or not confirmed then 'account_unconfirmed' when local_date is not null and time_zone is null then 'timezone_unconfirmed' when authority_id is null and dataset_count>1 then 'dataset_ambiguous' when dataset is null then 'dataset_unselected' when revision_count>1 then 'revision_ambiguous' when version is null then 'version_unsupported' when value_count>1 then 'value_ambiguous' else null end as reason from candidates d
)
select source,account,metric,activity_id,sub_identity,local_date,observed_at,time_zone,authority_id,authority_version,dataset,reason,
 case when reason is null then candidate_ids[1] else null end as current_id,
 case when reason in ('revision_ambiguous','version_unsupported') then observed_ids when reason='value_ambiguous' or reason is null then candidate_ids else array[]::uuid[] end as selected_ids,
 all_ids, array(select id from unnest(all_ids) id where not (id=any(coalesce(case when reason in ('revision_ambiguous','version_unsupported') then observed_ids when reason='value_ambiguous' or reason is null then candidate_ids else array[]::uuid[] end,array[]::uuid[]))) order by id) as unselected_ids from reasons;
