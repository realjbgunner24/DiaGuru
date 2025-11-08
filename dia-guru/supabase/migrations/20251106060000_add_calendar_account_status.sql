alter table public.calendar_accounts
  add column if not exists needs_reconnect boolean not null default false;

update public.calendar_accounts
set needs_reconnect = coalesce(needs_reconnect, false);
