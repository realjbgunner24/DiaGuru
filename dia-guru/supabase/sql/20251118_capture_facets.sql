-- Capture facets from LLM extraction
alter table if exists public.capture_entries
  add column if not exists urgency smallint null,
  add column if not exists impact smallint null,
  add column if not exists reschedule_penalty smallint null,
  add column if not exists blocking boolean default false,
  add column if not exists cannot_overlap boolean default false,
  add column if not exists start_flexibility text null,
  add column if not exists duration_flexibility text null,
  add column if not exists min_chunk_minutes integer null,
  add column if not exists max_splits integer null,
  add column if not exists extraction_kind text null,
  add column if not exists time_pref_time_of_day text null,
  add column if not exists time_pref_day text null,
  add column if not exists importance_rationale text null;

