-- Apple Health store. Same shape as the PepBros stores (peptides/doses/cycles/…):
-- one row per (user_id, id), data in jsonb, RLS scoped to the owner.
-- Run this once in the Supabase SQL editor (same place the other tables' DDL ran).
--
-- Row `id` conventions written by the health-ingest Edge Function:
--   metric:  "<metric_name>:<YYYY-MM-DD>"     data.kind = 'metric'
--   sleep:   "sleep:<YYYY-MM-DD>"             data.kind = 'sleep'
--   workout: "workout:<start-iso>"            data.kind = 'workout'
-- Daily re-exports upsert on the PK, so re-sending a day just overwrites it.

create table if not exists public.health (
  user_id    uuid        not null,
  id         text        not null,
  data       jsonb,
  updated_at timestamptz not null default now(),
  deleted    boolean     not null default false,
  primary key (user_id, id)
);

alter table public.health enable row level security;

-- Client/anon access is owner-only. The Edge Function and the MCP server both use
-- the service_role key, which bypasses RLS — this policy guards everything else.
drop policy if exists own_rows on public.health;
create policy own_rows on public.health
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
