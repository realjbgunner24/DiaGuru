alter table public.capture_entries
  add column if not exists constraint_type text not null default 'flexible',
  add column if not exists constraint_time timestamptz,
  add column if not exists constraint_end timestamptz,
  add column if not exists constraint_date date,
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
