create table if not exists public.capture_chunks (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references public.capture_entries(id) on delete cascade,
  start timestamptz not null,
  "end" timestamptz not null,
  late boolean not null default false,
  overlapped boolean not null default false,
  prime boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists capture_chunks_capture_id_idx on public.capture_chunks (capture_id);
create index if not exists capture_chunks_start_idx on public.capture_chunks (start);
