-- Baseline tables so later migrations (like needs_reconnect) succeed locally
create table if not exists public.calendar_accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  provider text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.calendar_tokens (
  account_id bigint references public.calendar_accounts(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  expiry timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

