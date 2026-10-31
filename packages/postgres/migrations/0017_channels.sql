create table brain.channels (id uuid primary key, kind text not null, bot_ref text not null);
create table brain.channel_conversations (id uuid primary key, channel_id uuid not null references brain.channels(id), external_ref text not null, thread_ref text);
create table brain.channel_requests (
 id uuid primary key, conversation_id uuid not null references brain.channel_conversations(id), producer text not null,
 producer_result_id text not null, purpose text not null, revision text, body text not null, created_at timestamptz not null,
 work_item_id uuid references brain.work_items(id), status text not null default 'pending' check (status in ('pending','sent')),
 external_message_id text, check (status = 'sent' or external_message_id is null)
);
create unique index channel_request_semantic_key on brain.channel_requests (producer_result_id, conversation_id, purpose, coalesce(revision, ''), (revision is null));
create table brain.channel_gates (request_id uuid primary key references brain.channel_requests(id), work_item_id uuid not null references brain.work_items(id), attempt_token uuid not null, created_at timestamptz not null);
create table brain.channel_attempt_results (request_id uuid primary key references brain.channel_requests(id), work_item_id uuid not null references brain.work_items(id), attempt_token uuid not null, external_message_id text, created_at timestamptz not null);
create trigger channel_gate_fence before insert on brain.channel_gates for each row execute function brain.reject_stale_attempt('work_item_id', 'attempt_token');
create trigger channel_result_fence before insert on brain.channel_attempt_results for each row execute function brain.reject_stale_attempt('work_item_id', 'attempt_token');
revoke all on brain.channels, brain.channel_conversations, brain.channel_requests, brain.channel_gates, brain.channel_attempt_results from public;
grant select, insert, update on brain.channels, brain.channel_conversations, brain.channel_requests to brain_app;
grant select, insert on brain.channel_gates, brain.channel_attempt_results to brain_app;
