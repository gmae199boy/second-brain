alter table brain.work_attempts
  add column error_code text,
  add column error_retryable boolean,
  add column input_tokens bigint,
  add column cached_input_tokens bigint,
  add column output_tokens bigint,
  add column elapsed_ms bigint,
  add column stderr text,
  add constraint work_attempts_usage_check check (
    (input_tokens is null and cached_input_tokens is null and output_tokens is null)
    or (input_tokens is not null and cached_input_tokens is not null and output_tokens is not null
        and input_tokens >= 0 and cached_input_tokens >= 0 and output_tokens >= 0)),
  add constraint work_attempts_elapsed_check check (elapsed_ms >= 0),
  add constraint work_attempts_error_outcome_check check (error_code is null or (outcome is not null and outcome = 'failed')),
  add constraint work_attempts_retryable_check check (error_retryable is null or error_code is not null);
