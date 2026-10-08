-- =============================================================================
-- CampusPrint — security hardening (applied on top of the initial schema)
-- =============================================================================
--   1. Rate limiting (atomic, DB-side)
--   2. create_order -> create_order_verified (server-verified page counts only)
--   3. cancel_order: rate limited
--   4. Payment functions (service_role only): attach gateway order, process webhook
--   5. File purge functions (service_role only) for the purge Edge Function
--   6. Storage: uploads only through server-issued signed upload URLs
--   7. Missing foreign-key indexes + housekeeping cron job
--
-- Nothing here weakens an existing policy. The only access removed is the
-- client-callable create_order() (a client could claim any page_count) and the
-- direct client INSERT into the print-files bucket (uploads now get a
-- server-chosen path through a signed upload URL).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Rate limiting
-- -----------------------------------------------------------------------------
-- Fixed window per key. The single INSERT ... ON CONFLICT row-locks the key, so
-- concurrent callers are serialised and counted exactly. Uses now() (database
-- time); callers never supply a timestamp.
create table private.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int         not null default 0
);

create function private.rate_limit_hit(p_key text, p_limit int, p_window interval)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_hits int;
begin
  insert into private.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case when r.window_start < now() - p_window then now() else r.window_start end,
        hits         = case when r.window_start < now() - p_window then 1 else r.hits + 1 end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- Callable by the server (service role) for per-IP / per-user limits on routes.
create function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null or length(p_key) > 200 or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid rate limit arguments' using errcode = '22023';
  end if;
  return private.rate_limit_hit(p_key, p_limit, make_interval(secs => p_window_seconds));
end $$;

revoke all on function public.check_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, int, int) to service_role;
revoke all on function private.rate_limit_hit(text, int, interval) from public, anon, authenticated;

alter table private.rate_limits enable row level security;  -- no policies: nobody but the owner

-- -----------------------------------------------------------------------------
-- 2. create_order_verified  (replaces the client-callable create_order)
-- -----------------------------------------------------------------------------
-- The browser can no longer call this. The Next.js server calls it with the
-- service role AFTER it has (a) authenticated the user, (b) downloaded each file
-- from private Storage, (c) checked its magic bytes and size, and (d) counted
-- the PDF's pages itself. page_count / size_bytes / mime_type in p_files are
-- therefore server-verified values. The function still re-checks everything it
-- can see from inside the database (path shape, ownership, storage metadata).
--
-- p_files: [{"storage_path": "<uid>/<upload-uuid>/<file-uuid>.pdf",
--            "original_name": "notes.pdf", "mime_type": "application/pdf",
--            "size_bytes": 123456, "page_count": 12}]
drop function public.create_order(uuid, text, text, text, int, jsonb, text);

create function public.create_order_verified(
  p_user_id      uuid,
  p_shop_id      uuid,
  p_colour_mode  text,
  p_paper_size   text,
  p_sides        text,
  p_copies       int,
  p_files        jsonb,
  p_student_note text default null
) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  c_uuid   constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_shop   public.shops;
  v_rate   int;
  v_pages  int := 0;
  v_sheets int := 0;
  v_file   jsonb;
  v_path   text;
  v_ext    text;
  v_mime   text;
  v_size   bigint;
  v_pc     int;
  v_name   text;
  v_existing public.orders;
  v_order  public.orders;
begin
  if p_user_id is null then
    raise exception 'Sign in to place an order' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles
                  where id = p_user_id and role = 'student' and deleted_at is null) then
    raise exception 'Only students can place orders' using errcode = '42501';
  end if;

  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) not between 1 and 10 then
    raise exception 'Attach between 1 and 10 files' using errcode = '22023';
  end if;

  -- Idempotent retry: if the first file is already attached to one of THIS
  -- user's still-unpaid orders, return that order instead of failing/duplicating.
  v_path := p_files -> 0 ->> 'storage_path';
  if v_path is not null then
    select o.* into v_existing
      from public.order_files f join public.orders o on o.id = f.order_id
     where f.storage_path = v_path and o.student_id = p_user_id;
    if found then
      if v_existing.status = 'PENDING' and v_existing.payment_status in ('PENDING', 'FAILED') then
        return v_existing;
      end if;
      raise exception 'File already used' using errcode = '23505';
    end if;
  end if;

  if not private.rate_limit_hit('create_order:' || p_user_id::text, 10, interval '1 hour') then
    raise exception 'Too many requests' using errcode = 'RL001';
  end if;

  if p_colour_mode is null or p_colour_mode not in ('bw', 'colour')
     or p_paper_size is null or p_paper_size not in ('a4', 'a3')
     or p_sides is null or p_sides not in ('single', 'double') then
    raise exception 'Invalid print options' using errcode = '22023';
  end if;
  if p_copies is null or p_copies not between 1 and 20 then
    raise exception 'Copies must be between 1 and 20' using errcode = '22023';
  end if;

  select * into v_shop from public.shops
   where id = p_shop_id and deleted_at is null and is_verified;
  if not found then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;
  if not v_shop.is_open then
    raise exception 'This shop is closed right now' using errcode = 'P0001';
  end if;

  -- The rate comes from the database, never from the caller.
  select sp.price_paise into v_rate
    from public.shop_pricing sp
   where sp.shop_id = p_shop_id and sp.service = 'print'
     and sp.colour_mode = p_colour_mode and sp.paper_size = p_paper_size
     and sp.is_active and sp.deleted_at is null;
  if not found then
    raise exception 'This shop does not offer that print option' using errcode = 'P0002';
  end if;

  for v_file in select e from jsonb_array_elements(p_files) as e loop
    if jsonb_typeof(v_file) <> 'object' then
      raise exception 'Invalid file' using errcode = '22023';
    end if;
    v_path := v_file ->> 'storage_path';
    v_mime := v_file ->> 'mime_type';

    -- Exactly <uid>/<uuid>/<uuid>.<ext>, all lower-case: no traversal, no other
    -- user's folder, no bucket root.
    if v_path is null or v_path !~ ('^' || p_user_id::text || '/' || c_uuid || '/' || c_uuid || '\.(pdf|png|jpg|jpeg)$') then
      raise exception 'Invalid file path' using errcode = '42501';
    end if;
    v_ext := substring(v_path from '\.([a-z]+)$');
    if not ((v_ext = 'pdf' and v_mime = 'application/pdf')
         or (v_ext = 'png' and v_mime = 'image/png')
         or (v_ext in ('jpg', 'jpeg') and v_mime = 'image/jpeg')) then
      raise exception 'Unsupported file type' using errcode = '22023';
    end if;

    if coalesce(v_file ->> 'size_bytes', '') !~ '^[0-9]{1,9}$'
       or coalesce(v_file ->> 'page_count', '') !~ '^[0-9]{1,4}$' then
      raise exception 'Invalid file details' using errcode = '22023';
    end if;
    v_size := (v_file ->> 'size_bytes')::bigint;
    v_pc   := (v_file ->> 'page_count')::int;
    if v_size < 1 or v_size > 26214400 then
      raise exception 'File too large' using errcode = '22023';
    end if;
    -- Images are one page. PDFs: 1..500 pages (server-counted).
    if (v_mime <> 'application/pdf' and v_pc <> 1) or v_pc not between 1 and 500 then
      raise exception 'Invalid page count' using errcode = '22023';
    end if;

    -- The stored object must exist and match what the server verified.
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'print-files' and o.name = v_path
                      and o.metadata ->> 'size' = v_size::text
                      and o.metadata ->> 'mimetype' = v_mime) then
      raise exception 'File has not been uploaded' using errcode = 'P0002';
    end if;

    v_pages  := v_pages + v_pc;
    v_sheets := v_sheets + case when p_sides = 'double' then (v_pc + 1) / 2 else v_pc end;
  end loop;

  if v_pages > 1000 then
    raise exception 'Too many pages' using errcode = '22023';
  end if;
  v_sheets := v_sheets * p_copies;

  insert into public.orders (
    student_id, shop_id, colour_mode, paper_size, sides, copies,
    total_pages, sheets, rate_per_sheet_paise, total_paise, student_note
  ) values (
    p_user_id, p_shop_id, p_colour_mode, p_paper_size, p_sides, p_copies,
    v_pages, v_sheets, v_rate, v_rate * v_sheets, left(nullif(btrim(p_student_note), ''), 500)
  ) returning * into v_order;

  insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count)
  select v_order.id, f ->> 'storage_path',
         coalesce(nullif(left(regexp_replace(coalesce(f ->> 'original_name', ''), '[\x00-\x1f\x7f/\\]', '_', 'g'), 255), ''), 'document'),
         f ->> 'mime_type', (f ->> 'size_bytes')::bigint, (f ->> 'page_count')::int
    from jsonb_array_elements(p_files) as f;

  return v_order;
end $$;

revoke all on function public.create_order_verified(uuid, uuid, text, text, text, int, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_order_verified(uuid, uuid, text, text, text, int, jsonb, text) to service_role;

-- -----------------------------------------------------------------------------
-- 3. cancel_order — same behaviour, now rate limited
-- -----------------------------------------------------------------------------
create or replace function public.cancel_order(p_order_id uuid) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_order public.orders;
begin
  if v_uid is null then
    raise exception 'Sign in to cancel an order' using errcode = '28000';
  end if;
  if not private.rate_limit_hit('cancel_order:' || v_uid::text, 20, interval '10 minutes') then
    raise exception 'Too many requests' using errcode = 'RL001';
  end if;

  select * into v_order from public.orders
   where id = p_order_id and student_id = v_uid
   for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'PENDING' then
    raise exception 'This order can no longer be cancelled' using errcode = 'P0001';
  end if;

  update public.orders
     set status = 'CANCELLED', status_reason = 'Cancelled by student'
   where id = p_order_id
   returning * into v_order;

  return v_order;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Payment functions (service role only)
-- -----------------------------------------------------------------------------
-- Store the gateway order id on an order. Idempotent: if one is already stored,
-- the stored one wins (two concurrent "pay" clicks cannot attach two).
create function public.attach_payment_order(
  p_order_id uuid, p_user_id uuid, p_payment_order_id text
) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
begin
  if p_payment_order_id is null or p_payment_order_id !~ '^order_[A-Za-z0-9]{6,40}$' then
    raise exception 'Invalid payment reference' using errcode = '22023';
  end if;
  select * into v_order from public.orders
   where id = p_order_id and student_id = p_user_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'PENDING' or v_order.payment_status not in ('PENDING', 'FAILED') then
    raise exception 'Order cannot be paid' using errcode = 'P0001';
  end if;
  if v_order.payment_order_id is not null then
    return v_order;
  end if;
  update public.orders set payment_order_id = p_payment_order_id
   where id = p_order_id returning * into v_order;
  return v_order;
end $$;

-- Apply one verified gateway event. The caller (webhook route) has ALREADY
-- verified the HMAC signature. Order of operations:
--   1. record the event (unique provider+event_id) -> a replay stops here
--   2. find the order by the gateway order id
--   3. verify currency and amount against OUR stored total
--   4. only then change payment state (the lifecycle trigger enforces legal moves)
-- Returns a short status string; never raises for business-rule mismatches so the
-- gateway is not told to retry forever.
create function public.process_payment_event(
  p_provider text, p_event_id text, p_event_type text,
  p_payment_order_id text, p_payment_id text,
  p_amount_paise int, p_currency text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.orders;
  v_result text;
  v_inserted int;
begin
  if p_provider is null or p_event_id is null or p_event_type is null
     or length(p_event_id) > 100 or length(p_event_type) > 60 then
    raise exception 'Invalid event' using errcode = '22023';
  end if;

  select * into v_order from public.orders
   where (p_payment_order_id is not null and payment_order_id = p_payment_order_id)
      or (p_payment_order_id is null and p_payment_id is not null and payment_id = p_payment_id)
   for update;

  insert into public.payment_events (provider, event_id, event_type, order_id, payload)
  values (p_provider, p_event_id, p_event_type, v_order.id, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 'duplicate';
  end if;

  if v_order.id is null then
    v_result := 'unknown_order';
  elsif p_event_type in ('payment.captured', 'order.paid') then
    if p_currency is distinct from 'INR' or p_amount_paise is distinct from v_order.total_paise then
      v_result := 'amount_mismatch';
    elsif v_order.payment_status in ('PENDING', 'FAILED') then
      update public.orders set payment_status = 'PAID', payment_id = coalesce(p_payment_id, payment_id)
       where id = v_order.id;
      v_result := 'paid';
    else
      v_result := 'ignored_state';
    end if;
  elsif p_event_type = 'payment.failed' then
    if v_order.payment_status = 'PENDING' then
      update public.orders set payment_status = 'FAILED' where id = v_order.id;
      v_result := 'failed';
    else
      v_result := 'ignored_state';
    end if;
  elsif p_event_type in ('refund.processed') then
    if v_order.payment_status = 'REFUND_PENDING' then
      update public.orders set payment_status = 'REFUNDED' where id = v_order.id;
      v_result := 'refunded';
    else
      v_result := 'ignored_state';
    end if;
  else
    v_result := 'ignored';
  end if;

  update public.payment_events set processed_at = now()
   where provider = p_provider and event_id = p_event_id;
  return v_result;
end $$;

revoke all on function public.attach_payment_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.attach_payment_order(uuid, uuid, text) to service_role;
revoke all on function public.process_payment_event(text, text, text, text, text, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.process_payment_event(text, text, text, text, text, int, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 5. File purge functions (service role only; used by the purge Edge Function)
-- -----------------------------------------------------------------------------
-- Files of orders that reached a final state at least 7 days ago
-- (orders.files_purge_after, set by the lifecycle trigger). Never active orders.
create function public.files_due_for_purge(p_limit int default 100)
returns table (file_id uuid, storage_path text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.storage_path
    from public.order_files f
    join public.orders o on o.id = f.order_id
   where f.file_deleted_at is null
     and o.status in ('COMPLETED', 'CANCELLED', 'REJECTED')
     and o.files_purge_after is not null
     and o.files_purge_after <= now()
   order by o.files_purge_after
   limit least(greatest(p_limit, 1), 500)
$$;

-- Uploads that never became part of an order, older than p_older_than.
create function public.orphan_uploads(p_older_than interval default interval '24 hours', p_limit int default 100)
returns table (storage_path text)
language sql stable security definer set search_path = '' as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'print-files'
     and o.created_at < now() - greatest(p_older_than, interval '1 hour')
     and not exists (select 1 from public.order_files f where f.storage_path = o.name)
   order by o.created_at
   limit least(greatest(p_limit, 1), 500)
$$;

-- Record that the Storage API actually deleted these files. Idempotent.
create function public.mark_files_purged(p_file_ids uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  update public.order_files set file_deleted_at = coalesce(file_deleted_at, now())
   where id = any (p_file_ids)
     and order_id in (select o.id from public.orders o
                       where o.status in ('COMPLETED', 'CANCELLED', 'REJECTED')
                         and o.files_purge_after <= now());
  get diagnostics v_n = row_count;

  update public.orders o set files_purged_at = now()
   where o.files_purged_at is null
     and o.id in (select f.order_id from public.order_files f where f.id = any (p_file_ids))
     and not exists (select 1 from public.order_files f2
                      where f2.order_id = o.id and f2.file_deleted_at is null);
  return v_n;
end $$;

revoke all on function public.files_due_for_purge(int) from public, anon, authenticated;
revoke all on function public.orphan_uploads(interval, int) from public, anon, authenticated;
revoke all on function public.mark_files_purged(uuid[]) from public, anon, authenticated;
grant execute on function public.files_due_for_purge(int) to service_role;
grant execute on function public.orphan_uploads(interval, int) to service_role;
grant execute on function public.mark_files_purged(uuid[]) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Storage: no direct client uploads
-- -----------------------------------------------------------------------------
-- Uploads happen through a signed upload URL that the server issues for a path
-- IT chose (<uid>/<uuid>/<uuid>.<ext>) after rate-limiting and validating the
-- request. Clients can no longer pick their own path or bypass the limiter.
-- SELECT policies (own files / shop files / admin) are unchanged.
drop policy print_files_insert_own on storage.objects;

-- -----------------------------------------------------------------------------
-- 7. Foreign-key indexes + housekeeping
-- -----------------------------------------------------------------------------
create index notifications_order_idx   on public.notifications (order_id);
create index payment_events_order_idx  on public.payment_events (order_id);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'campusprint-prune-rate-limits',
      '17 * * * *',
      $job$delete from private.rate_limits where window_start < now() - interval '1 day'$job$
    );
  end if;
end $$;

commit;
