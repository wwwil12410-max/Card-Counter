create table if not exists public.rooms (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

drop policy if exists "rooms are publicly readable" on public.rooms;
create policy "rooms are publicly readable"
on public.rooms
for select
to anon
using (true);

drop policy if exists "rooms are publicly insertable" on public.rooms;
create policy "rooms are publicly insertable"
on public.rooms
for insert
to anon
with check (true);

drop policy if exists "rooms are publicly updatable" on public.rooms;
create policy "rooms are publicly updatable"
on public.rooms
for update
to anon
using (true)
with check (true);

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception
  when duplicate_object then null;
end $$;
