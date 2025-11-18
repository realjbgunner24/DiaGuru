alter table public.capture_entries
  add column if not exists deadline_at timestamptz,
  add column if not exists window_start timestamptz,
  add column if not exists window_end timestamptz,
  add column if not exists start_target_at timestamptz,
  add column if not exists is_soft_start boolean not null default false,
  add column if not exists externality_score smallint not null default 0,
  add column if not exists reschedule_count smallint not null default 0,
  add column if not exists task_type_hint text,
  add column if not exists freeze_until timestamptz,
  add column if not exists plan_id uuid,
  add column if not exists manual_touch_at timestamptz,
  add column if not exists calendar_event_etag text;

comment on column public.capture_entries.deadline_at is
  'Hard deadline timestamp (task must finish before this time).';

comment on column public.capture_entries.window_start is
  'Optional start of a scheduling window.';

comment on column public.capture_entries.window_end is
  'Optional end of a scheduling window.';

comment on column public.capture_entries.start_target_at is
  'Preferred exact start time when task is anchored.';

comment on column public.capture_entries.is_soft_start is
  'Whether the start_target_at can slide (soft start).';

comment on column public.capture_entries.externality_score is
  'Boost when other people/external commitments depend on the task.';

comment on column public.capture_entries.reschedule_count is
  'How many times DiaGuru has moved this capture.';

comment on column public.capture_entries.task_type_hint is
  'Derived task type (deep_work, admin, creative, errand, etc.).';

comment on column public.capture_entries.freeze_until is
  'Timestamp until which the capture''s scheduled event is locked.';

comment on column public.capture_entries.plan_id is
  'Identifier of the last scheduling plan that touched this capture.';

comment on column public.capture_entries.manual_touch_at is
  'When the user last manually edited the related calendar event.';

comment on column public.capture_entries.calendar_event_etag is
  'Last known Google Calendar event etag (used for concurrency control).';
