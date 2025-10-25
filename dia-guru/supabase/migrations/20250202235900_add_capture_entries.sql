-- Create capture_entries table to store daily capture items
create table if not exists public.capture_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  estimated_minutes integer check (estimated_minutes >= 0),
  importance smallint not null default 1 check (importance between 1 and 3),
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'completed')),
  scheduled_for timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.capture_entries enable row level security;

-- Ensure helper function exists to keep updated_at current
create or replace function public.set_updated_at_timestamp()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create trigger set_capture_entries_updated_at
before update on public.capture_entries
for each row
execute procedure public.set_updated_at_timestamp();

-- Row level security policies scoped to the authenticated user
create policy "Users can select their capture entries"
  on public.capture_entries
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their capture entries"
  on public.capture_entries
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their capture entries"
  on public.capture_entries
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their capture entries"
  on public.capture_entries
  for delete
  using (auth.uid() = user_id);
