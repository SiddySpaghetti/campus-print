/**
 * An in-process Postgres (PGlite) with the REAL supabase/migrations applied in
 * order. Only Supabase's own pieces are stubbed: the API roles, auth.users,
 * auth.uid() (Supabase's definition: the `sub` of request.jwt.claim.sub or of
 * the request.jwt.claims JSON), the storage tables, and the grants Supabase
 * gives those roles by default. Not a full Supabase: no Auth/Storage HTTP APIs,
 * no PostgREST, no pg_cron.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUPABASE_STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage;
create table auth.users (id uuid primary key, email text, aud text, role text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  created_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable
  as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema auth, storage to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;

/**
 * `before` runs SQL just before the migration whose file name starts with the
 * key — e.g. production-like shops and old orders, so a data migration is
 * tested against the state it will really meet.
 */
export async function freshSupabaseDb(before: Record<string, string> = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const dir = join(ROOT, "supabase/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const [prefix, sql] of Object.entries(before)) if (f.startsWith(prefix)) await db.exec(sql);
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  // Supabase gives service_role these through default privileges.
  await db.exec("grant all on all tables in schema public to service_role;");
  return db;
}
