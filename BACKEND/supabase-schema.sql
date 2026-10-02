-- =========================================================================
-- Neighborly — persistent storage (Supabase / Postgres)
--
-- Run this ONCE in the Supabase SQL Editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).
--
-- Before your first run, delete the tables from any earlier attempt:
--   drop table if exists neighborly_dm_messages;
--   drop table if exists neighborly_channel_messages;
--   drop table if exists neighborly_requests;
--   drop table if exists neighborly_friends;
--   drop table if exists neighborly_profiles;
--
-- The server talks to these tables with the service_role key, which bypasses
-- RLS, so every table is locked down against direct browser access.
-- =========================================================================

-- Public profiles, keyed by the lowercase handle (no leading @).
create table if not exists neighborly_profiles (
  handle_key   text primary key,
  handle       text not null,
  name         text not null default '',
  email        text not null default '',
  initials     text not null default '',
  color        text not null default '#7c6ff7',
  avatar_image text,
  updated_at   timestamptz not null default now()
);

-- Friend graph. One row per direction; both directions are written.
create table if not exists neighborly_friends (
  owner_key  text not null references neighborly_profiles(handle_key) on delete cascade,
  friend_key text not null references neighborly_profiles(handle_key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_key, friend_key)
);

create index if not exists neighborly_friends_owner_idx
  on neighborly_friends (owner_key);

-- Friend requests. `id` is client-generated and used for upserts.
create table if not exists neighborly_requests (
  id         text primary key,
  from_key   text not null references neighborly_profiles(handle_key) on delete cascade,
  to_key     text not null references neighborly_profiles(handle_key) on delete cascade,
  status     text not null default 'pending'
             check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz not null default now()
);

create index if not exists neighborly_requests_to_idx
  on neighborly_requests (to_key, status);
create index if not exists neighborly_requests_from_idx
  on neighborly_requests (from_key, status);

-- Direct messages. `conversation_key` is the sorted handle pair joined by
-- ':' (e.g. 'alice:bob'), so both participants resolve to the same room.
create table if not exists neighborly_dm_messages (
  id              text primary key,
  conversation_key text not null,
  sender_key      text not null,
  text            text not null default '',
  attachment      jsonb,
  reply_to        jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists neighborly_dm_conversation_idx
  on neighborly_dm_messages (conversation_key, created_at desc);

-- Server channel messages. Same guarantees as DMs: stored durably so channel
-- history survives a restart, and never exposed to the browser.
create table if not exists neighborly_channel_messages (
  id           text primary key,
  channel      text not null,
  author       text not null default 'Neighborly User',
  text         text not null default '',
  attachment   jsonb,
  author_handle text,
  author_color text,
  author_avatar text,
  created_at   timestamptz not null default now()
);

create index if not exists neighborly_channel_messages_channel_idx
  on neighborly_channel_messages (channel, created_at desc);

-- ===== Lock everything down ================================================
-- The anon key is public (it ships in the browser). Without RLS the anon role
-- could read and write every user's messages, so RLS is enabled on all four
-- tables and no permissive policy is added: only the service_role key
-- (server-side only) can reach them.

alter table neighborly_profiles    enable row level security;
alter table neighborly_friends     enable row level security;
alter table neighborly_requests    enable row level security;
alter table neighborly_dm_messages enable row level security;
alter table neighborly_channel_messages enable row level security;

-- (intentionally no policies -> anon/authenticated get zero rows)