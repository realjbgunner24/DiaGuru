alter table public.capture_entries
  add column if not exists constraint_type text default 'flexible';

alter table public.capture_entries
  alter column constraint_type set not null;

alter table public.capture_entries
  add column if not exists constraint_time timestamptz;

alter table public.capture_entries
  add column if not exists constraint_end timestamptz;

alter table public.capture_entries
  add column if not exists constraint_date date;

alter table public.capture_entries
  add column if not exists original_target_time timestamptz;

alter table public.capture_entries
  drop constraint if exists capture_entries_constraint_type_check;

alter table public.capture_entries
  add constraint capture_entries_constraint_type_check
  check (
    constraint_type in (
      'flexible',
      'deadline_time',
      'deadline_date',
      'start_time',
      'window'
    )
  );
