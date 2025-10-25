alter table public.capture_entries
  add column if not exists calendar_event_id text,
  add column if not exists planned_start timestamptz,
  add column if not exists planned_end timestamptz,
  add column if not exists last_check_in timestamptz,
  add column if not exists scheduling_notes text;

alter table public.capture_entries
  drop constraint if exists capture_entries_status_check;

alter table public.capture_entries
  add constraint capture_entries_status_check
  check (status in ('pending', 'scheduled', 'awaiting_confirmation', 'completed'));

create index if not exists capture_entries_user_status_idx
  on public.capture_entries (user_id, status);

create index if not exists capture_entries_planned_start_idx
  on public.capture_entries (planned_start);
