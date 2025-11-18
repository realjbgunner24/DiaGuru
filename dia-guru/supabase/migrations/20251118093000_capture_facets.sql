-- Adds LLM-derived capture facets used by scheduling and priority.
-- Safe to run multiple times (IF NOT EXISTS on every column).

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

comment on column public.capture_entries.urgency is 'LLM: urgency 1-5 (time pressure).';
comment on column public.capture_entries.impact is 'LLM: impact 1-5 (stakes).';
comment on column public.capture_entries.reschedule_penalty is 'LLM: 0-3 (0=move freely, 3=avoid moving).';
comment on column public.capture_entries.blocking is 'LLM: other tasks depend on this (true/false).';
comment on column public.capture_entries.cannot_overlap is 'LLM: must not overlap other events.';
comment on column public.capture_entries.start_flexibility is 'LLM: hard|soft|anytime';
comment on column public.capture_entries.duration_flexibility is 'LLM: fixed|split_allowed';
comment on column public.capture_entries.min_chunk_minutes is 'LLM: minimum chunk size if split_allowed.';
comment on column public.capture_entries.max_splits is 'LLM: maximum number of splits if split_allowed.';
comment on column public.capture_entries.extraction_kind is 'LLM: task|appointment|call|meeting|study|errand|other.';
comment on column public.capture_entries.time_pref_time_of_day is 'LLM: morning|afternoon|evening|night (soft preference).';
comment on column public.capture_entries.time_pref_day is 'LLM: today|tomorrow|specific_date|any (soft preference).';
comment on column public.capture_entries.importance_rationale is 'LLM: short explanation for the importance scores.';

