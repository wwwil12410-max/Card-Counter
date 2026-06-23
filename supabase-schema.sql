create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.room_access (
  room_id text primary key references public.rooms(id) on delete cascade,
  owner_password_hash text not null,
  player_password_hash text not null default '',
  access_version integer not null default 1,
  allow_player_edit boolean not null default true,
  closed boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.room_sessions (
  token_hash text primary key,
  room_id text not null references public.rooms(id) on delete cascade,
  role text not null check (role in ('owner', 'player')),
  access_version integer not null default 1,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create table if not exists public.room_tokens (
  token_hash text primary key,
  token_type text not null check (token_type in ('join', 'grant')),
  room_id text references public.rooms(id) on delete cascade,
  expires_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.room_access add column if not exists player_password_hash text not null default '';
alter table public.room_access add column if not exists access_version integer not null default 1;
alter table public.room_access add column if not exists allow_player_edit boolean not null default true;
alter table public.room_access add column if not exists closed boolean not null default false;
alter table public.room_access add column if not exists updated_at timestamptz not null default now();

alter table public.room_sessions add column if not exists access_version integer not null default 1;

alter table public.rooms enable row level security;
alter table public.room_access enable row level security;
alter table public.room_sessions enable row level security;
alter table public.room_tokens enable row level security;

drop policy if exists "rooms are publicly readable" on public.rooms;
create policy "rooms are publicly readable"
on public.rooms
for select
to anon
using (true);

drop policy if exists "rooms are publicly insertable" on public.rooms;
drop policy if exists "rooms are publicly updatable" on public.rooms;
drop policy if exists "room access is service-role only" on public.room_access;
drop policy if exists "room sessions are service-role only" on public.room_sessions;
drop policy if exists "room tokens are service-role only" on public.room_tokens;

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception
  when duplicate_object then null;
end $$;
