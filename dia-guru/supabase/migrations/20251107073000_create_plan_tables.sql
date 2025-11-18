create table if not exists public.plan_runs (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  summary text,
  created_at timestamptz not null default timezone('utc', now()),
  undone_at timestamptz,
  undo_user_id uuid references auth.users (id)
);

comment on table public.plan_runs is 'Tracks each automatic scheduling plan run.';
comment on column public.plan_runs.summary is 'Optional human-readable summary for the plan.';
comment on column public.plan_runs.undone_at is 'When the plan was rolled back (if ever).';

create table if not exists public.plan_actions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plan_runs(id) on delete cascade,
  action_id uuid not null,
  capture_id uuid not null references public.capture_entries(id) on delete cascade,
  capture_content text not null,
  action_type text not null check (action_type in ('scheduled', 'rescheduled', 'unscheduled')),
  prev_status text,
  prev_planned_start timestamptz,
  prev_planned_end timestamptz,
  prev_calendar_event_id text,
  prev_calendar_event_etag text,
  prev_freeze_until timestamptz,
  prev_plan_id uuid,
  next_status text,
  next_planned_start timestamptz,
  next_planned_end timestamptz,
  next_calendar_event_id text,
  next_calendar_event_etag text,
  next_freeze_until timestamptz,
  next_plan_id uuid,
  performed_at timestamptz not null default timezone('utc', now())
);

comment on table public.plan_actions is 'Per-capture mutations performed during a plan (used for explanations + undo).';

create index if not exists plan_actions_plan_id_idx
  on public.plan_actions (plan_id);

create index if not exists plan_actions_capture_id_idx
  on public.plan_actions (capture_id);
