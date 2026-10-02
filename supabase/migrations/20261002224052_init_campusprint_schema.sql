-- =============================================================================
-- CampusPrint — initial schema
-- =============================================================================
-- Designed for a FRESH, EMPTY Supabase database. Run it once, in order.
--
-- Contents
--   1. Schema + enums
--   2. Tables + indexes
--   3. Helper functions
--   4. Triggers (updated_at, signup, column guards, order lifecycle, notifications)
--   5. RPC functions (create_order, cancel_order) + 24h unpaid auto-cancel
--   6. Row Level Security policies
--   7. Table / function privileges
--   8. Storage bucket + policies
--   9. Scheduled job (pg_cron) for unpaid-order cancellation
--  10. How to add the first shops / admin / shopkeepers (commented examples)
--
-- Security model, in one paragraph
--   RLS decides WHICH ROWS a caller can touch. It cannot restrict WHICH COLUMNS,
--   so BEFORE UPDATE "guard" triggers do that for non-admin callers. Anything
--   sensitive (creating an order, cancelling, paying, refunding) goes through a
--   SECURITY DEFINER function or the server (service role), never a raw client
--   write. Guards only apply when the statement runs as the `authenticated` or
--   `anon` database role; the SQL editor, migrations, the service role and
--   SECURITY DEFINER functions are trusted and skip them.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Schema + enums
-- -----------------------------------------------------------------------------

-- Internal helpers live here. It is NOT exposed through the Data API, so none
-- of these functions can be called by clients over HTTP.
create schema private;

create type public.user_role as enum ('student', 'shopkeeper', 'admin');

create type public.order_status as enum (
  'PENDING', 'ACCEPTED', 'PRINTING', 'READY', 'COMPLETED', 'CANCELLED', 'REJECTED'
);

-- REFUND_PENDING = the order was cancelled/rejected after payment and the
-- Razorpay refund has been requested but not yet confirmed.
create type public.payment_status as enum (
  'PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED'
);

-- -----------------------------------------------------------------------------
-- 2. Tables + indexes
-- -----------------------------------------------------------------------------

-- 2.1 shops — created manually by the admin. There is no public sign-up flow.
create table public.shops (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null,
  slug            text        not null unique,
  -- Single letter used in order numbers, e.g. 'A' -> A-042.
  order_prefix    char(1)     not null unique check (order_prefix ~ '^[A-Z]$'),
  description     text,
  address         text,
  phone           text,
  distance_metres int         check (distance_metres is null or distance_metres >= 0),
  is_verified     boolean     not null default false,  -- admin only
  is_open         boolean     not null default false,  -- shopkeeper toggles
  prep_minutes    int         not null default 15 check (prep_minutes > 0),
  sort_order      int         not null default 100,    -- lower = listed first; admin only
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz                          -- soft delete
);

-- What students see in the shop list.
create index shops_listing_idx on public.shops (sort_order, name)
  where deleted_at is null and is_verified;

-- 2.2 profiles — one row per login (auth.users).
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.user_role not null default 'student',
  full_name  text,
  phone      text,
  shop_id    uuid references public.shops (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- A shopkeeper must belong to a shop; nobody else may.
  constraint profiles_shop_matches_role check ((role = 'shopkeeper') = (shop_id is not null))
);

-- One shopkeeper account per shop for the MVP. To allow several staff accounts
-- per shop later, simply DROP this index — nothing else needs to change.
create unique index profiles_one_shopkeeper_per_shop
  on public.profiles (shop_id) where role = 'shopkeeper';

-- 2.3 shop_pricing — price PER SHEET, in paise. Double-sided printing changes
-- the number of sheets, never the rate. A3 has its own explicit price.
create table public.shop_pricing (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops (id) on delete cascade,
  service     text not null
              check (service in ('print', 'photocopy', 'scanning', 'binding', 'lamination')),
  colour_mode text check (colour_mode in ('bw', 'colour')),
  paper_size  text check (paper_size in ('a4', 'a3')),
  price_paise int  not null check (price_paise >= 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  -- Printing is priced by colour and paper size; other services may omit them.
  constraint shop_pricing_print_needs_options check (
    service <> 'print' or (colour_mode is not null and paper_size is not null)
  )
);

create unique index shop_pricing_unique_active on public.shop_pricing
  (shop_id, service, coalesce(colour_mode, ''), coalesce(paper_size, ''))
  where deleted_at is null;

-- 2.4 orders
create table public.orders (
  id                   uuid primary key default gen_random_uuid(),
  -- Assigned when payment succeeds (see private.orders_lifecycle), so abandoned
  -- carts never leave gaps in the sequence.
  order_number         text,
  -- Day the order number belongs to, in Indian time (the DB runs in UTC).
  order_date           date not null default ((now() at time zone 'Asia/Kolkata')::date),
  student_id           uuid not null references public.profiles (id) on delete restrict,
  shop_id              uuid not null references public.shops (id) on delete restrict,

  colour_mode          text not null check (colour_mode in ('bw', 'colour')),
  paper_size           text not null check (paper_size in ('a4', 'a3')),
  sides                text not null check (sides in ('single', 'double')),
  copies               int  not null check (copies between 1 and 20),
  total_pages          int  not null check (total_pages > 0),
  sheets               int  not null check (sheets > 0),
  -- Price SNAPSHOT: later changes to shop_pricing never alter existing orders.
  rate_per_sheet_paise int  not null check (rate_per_sheet_paise >= 0),
  total_paise          int  not null check (total_paise > 0),

  status               public.order_status   not null default 'PENDING',
  status_reason        text,   -- why it was rejected / cancelled
  student_note         text,

  -- Payment. Provider-agnostic column names; Razorpay is the MVP provider.
  payment_status       public.payment_status not null default 'PENDING',
  payment_provider     text not null default 'razorpay',
  payment_order_id     text,   -- Razorpay order_…
  payment_id           text,   -- Razorpay pay_…
  refund_id            text,   -- Razorpay rfnd_…
  paid_at              timestamptz,
  refund_requested_at  timestamptz,
  refunded_at          timestamptz,

  -- Set automatically on each status change.
  accepted_at          timestamptz,
  printing_at          timestamptz,
  ready_at             timestamptz,
  completed_at         timestamptz,
  rejected_at          timestamptz,
  cancelled_at         timestamptz,

  -- File purge bookkeeping: files_purge_after = final-state time + 7 days.
  files_purge_after    timestamptz,
  files_purged_at      timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint orders_total_matches_rate check (total_paise = rate_per_sheet_paise * sheets),
  constraint orders_paid_has_number    check (paid_at is null or order_number is not null)
);

create index orders_student_idx on public.orders (student_id, created_at desc);

-- Shopkeeper queue. `paid_at is not null` (not payment_status = 'PAID') because
-- paid_at never goes away, even after a refund.
create index orders_shop_active_idx on public.orders (shop_id, created_at desc)
  where paid_at is not null and status in ('PENDING', 'ACCEPTED', 'PRINTING', 'READY');

create unique index orders_number_key on public.orders (shop_id, order_date, order_number);
create unique index orders_payment_order_id_key on public.orders (payment_order_id)
  where payment_order_id is not null;
create index orders_refund_queue_idx on public.orders (refund_requested_at)
  where payment_status = 'REFUND_PENDING';
create index orders_files_purge_idx on public.orders (files_purge_after)
  where files_purged_at is null and files_purge_after is not null;
create index orders_stale_unpaid_idx on public.orders (created_at)
  where status = 'PENDING' and payment_status in ('PENDING', 'FAILED');

-- 2.5 order_files — metadata only. The bytes live in Storage (bucket print-files).
create table public.order_files (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  storage_path    text not null unique,
  -- Kept for good after the file itself is purged.
  original_name   text not null,
  mime_type       text not null
                  check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes      bigint not null check (size_bytes > 0 and size_bytes <= 26214400), -- 25 MB
  page_count      int    not null check (page_count > 0),
  created_at      timestamptz not null default now(),
  file_deleted_at timestamptz   -- set when the purge job removes the stored file
);

create index order_files_order_idx on public.order_files (order_id);

-- 2.6 notifications — written by triggers only.
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  order_id   uuid references public.orders (id) on delete set null,
  type       text not null,
  title      text not null,
  body       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_unread_idx on public.notifications (user_id, created_at desc)
  where read_at is null;

-- Helper: per-shop, per-day order number counter. No client access.
create table public.order_counters (
  shop_id     uuid not null references public.shops (id) on delete restrict,
  order_date  date not null,
  last_number int  not null default 0,
  primary key (shop_id, order_date)
);

-- Helper: raw payment webhook log. The unique key makes webhook retries
-- idempotent. Written by the server (service role) only.
create table public.payment_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text  not null,
  event_id     text  not null,
  event_type   text  not null,
  order_id     uuid references public.orders (id) on delete set null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

-- -----------------------------------------------------------------------------
-- 3. Helper functions
-- -----------------------------------------------------------------------------

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- SECURITY DEFINER so policies can ask "who is this?" without recursing into
-- the RLS policies of `profiles`. Soft-deleted profiles lose all privileges.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.role = 'admin' from public.profiles p
      where p.id = (select auth.uid()) and p.deleted_at is null),
    false)
$$;

-- The caller's shop if (and only if) they are an active shopkeeper.
create function private.my_shop_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.shop_id from public.profiles p
   where p.id = (select auth.uid())
     and p.role = 'shopkeeper'
     and p.deleted_at is null
$$;

-- Is this shop publicly listed (verified and not deleted)?
create function private.is_shop_listed(p_shop_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shops s
     where s.id = p_shop_id and s.deleted_at is null and s.is_verified
  )
$$;

-- Used by the Storage policy: may the caller's shop read this stored file?
create function private.shop_can_read_file(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.order_files f
      join public.orders o on o.id = f.order_id
     where f.storage_path = p_path
       and o.shop_id = private.my_shop_id()
       and o.paid_at is not null
  )
$$;

-- Next order number for a shop on a given day, e.g. 'A-042'. The upsert makes
-- the increment atomic, so concurrent payments never receive the same number.
create function private.next_order_number(p_shop_id uuid, p_date date) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  v_n      int;
begin
  select s.order_prefix into v_prefix from public.shops s where s.id = p_shop_id;

  insert into public.order_counters as c (shop_id, order_date, last_number)
  values (p_shop_id, p_date, 1)
  on conflict (shop_id, order_date)
  do update set last_number = c.last_number + 1
  returning c.last_number into v_n;

  -- lpad() would truncate numbers above 999, so only pad below that.
  return v_prefix || '-' || case when v_n < 1000 then lpad(v_n::text, 3, '0') else v_n::text end;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------

-- 4.1 updated_at. Named "…_30_…" so it runs after the guard ("…_10_…") and
-- the lifecycle ("…_20_…") triggers; Postgres fires same-event triggers in
-- alphabetical order.
create trigger profiles_30_updated_at     before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger shops_30_updated_at        before update on public.shops
  for each row execute function private.set_updated_at();
create trigger shop_pricing_30_updated_at before update on public.shop_pricing
  for each row execute function private.set_updated_at();
create trigger orders_30_updated_at       before update on public.orders
  for each row execute function private.set_updated_at();

-- 4.2 Signup: every new login gets a profile, ALWAYS as 'student'. The role is
-- deliberately never read from user-supplied metadata, so nobody can sign up as
-- a shopkeeper or admin. Admins promote people manually (see section 10).
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Cover any login that already exists.
insert into public.profiles (id) select id from auth.users on conflict do nothing;

-- 4.3 Column guards. RLS lets a user touch a row; these decide which COLUMNS.
-- They run as the caller (SECURITY INVOKER) so current_user is meaningful:
-- 'authenticated' for API users, but 'postgres' / 'service_role' for the SQL
-- editor, the server, and inside SECURITY DEFINER functions (which are trusted).
-- Admins are exempt.

create function private.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') or private.is_admin() then
    return new;
  end if;
  -- Users may edit only their name and phone — never role, shop_id or id.
  if (to_jsonb(new) - array['full_name', 'phone']::text[])
     is distinct from (to_jsonb(old) - array['full_name', 'phone']::text[]) then
    raise exception 'You can only change your name and phone number' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger profiles_10_guard before update on public.profiles
  for each row execute function private.profiles_guard();

create function private.shops_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') or private.is_admin() then
    return new;
  end if;
  -- Shopkeepers may only toggle open/closed and set the prep time.
  -- is_verified, sort_order, prefix, deleted_at, etc. are admin-only.
  if (to_jsonb(new) - array['is_open', 'prep_minutes']::text[])
     is distinct from (to_jsonb(old) - array['is_open', 'prep_minutes']::text[]) then
    raise exception 'You can only change is_open and prep_minutes' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger shops_10_guard before update on public.shops
  for each row execute function private.shops_guard();

create function private.notifications_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') or private.is_admin() then
    return new;
  end if;
  if (to_jsonb(new) - array['read_at']::text[]) is distinct from (to_jsonb(old) - array['read_at']::text[]) then
    raise exception 'You can only mark a notification as read' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger notifications_10_guard before update on public.notifications
  for each row execute function private.notifications_guard();

-- The only non-admin API user who can UPDATE orders is a shopkeeper (students
-- have no UPDATE policy; they cancel through cancel_order()).
create function private.orders_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') or private.is_admin() then
    return new;
  end if;
  -- Shopkeepers may change only status and status_reason. In particular they
  -- can never touch payment_status, prices, or the student.
  if (to_jsonb(new) - array['status', 'status_reason']::text[])
     is distinct from (to_jsonb(old) - array['status', 'status_reason']::text[]) then
    raise exception 'Shops can only update the order status' using errcode = '42501';
  end if;
  -- A pending order is the student's to cancel; the shop rejects it instead.
  if old.status = 'PENDING' and new.status = 'CANCELLED' then
    raise exception 'A shop cannot cancel a pending order; reject it instead' using errcode = '42501';
  end if;
  if new.status in ('REJECTED', 'CANCELLED') and new.status is distinct from old.status
     and nullif(btrim(coalesce(new.status_reason, '')), '') is null then
    raise exception 'A reason is required to reject or cancel an order' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger orders_10_guard before update on public.orders
  for each row execute function private.orders_guard();

-- 4.4 Order lifecycle: enforces the status flows and keeps the derived columns
-- (timestamps, order number, refund flag, purge date) consistent. Runs for
-- EVERY update, trusted or not.
create function private.orders_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
begin
  -- Order status flow. Cancelling after acceptance is allowed here but only
  -- shops/admins can do it (students go through cancel_order, PENDING only).
  if new.status is distinct from old.status then
    if not (
         (old.status = 'PENDING'  and new.status in ('ACCEPTED', 'REJECTED', 'CANCELLED'))
      or (old.status = 'ACCEPTED' and new.status in ('PRINTING', 'CANCELLED'))
      or (old.status = 'PRINTING' and new.status in ('READY', 'CANCELLED'))
      or (old.status = 'READY'    and new.status = 'COMPLETED')
    ) then
      raise exception 'Invalid order status change: % -> %', old.status, new.status
        using errcode = '23514';
    end if;

    -- Work on an order only after the money has arrived.
    if new.status in ('ACCEPTED', 'PRINTING', 'READY', 'COMPLETED')
       and new.payment_status <> 'PAID' then
      raise exception 'An unpaid order cannot be %', lower(new.status::text)
        using errcode = '23514';
    end if;

    case new.status
      when 'ACCEPTED'  then new.accepted_at  := v_now;
      when 'PRINTING'  then new.printing_at  := v_now;
      when 'READY'     then new.ready_at     := v_now;
      when 'COMPLETED' then new.completed_at := v_now;
      when 'REJECTED'  then new.rejected_at  := v_now;
      when 'CANCELLED' then new.cancelled_at := v_now;
      else null;
    end case;

    -- Retention: stored files are purged 7 days after the order is final.
    if new.status in ('COMPLETED', 'CANCELLED', 'REJECTED') then
      new.files_purge_after := v_now + interval '7 days';
    end if;
  end if;

  -- Payment status flow (written by the server / webhook, never by clients).
  if new.payment_status is distinct from old.payment_status then
    if not (
         (old.payment_status = 'PENDING'        and new.payment_status in ('PAID', 'FAILED'))
      or (old.payment_status = 'FAILED'         and new.payment_status in ('PENDING', 'PAID'))
      or (old.payment_status = 'PAID'           and new.payment_status = 'REFUND_PENDING')
      or (old.payment_status = 'REFUND_PENDING' and new.payment_status = 'REFUNDED')
    ) then
      raise exception 'Invalid payment status change: % -> %', old.payment_status, new.payment_status
        using errcode = '23514';
    end if;

    if new.payment_status = 'PAID' then
      new.paid_at := coalesce(new.paid_at, v_now);
      if new.order_number is null then
        -- The number belongs to the (Indian) day the payment arrived.
        new.order_date   := (v_now at time zone 'Asia/Kolkata')::date;
        new.order_number := private.next_order_number(new.shop_id, new.order_date);
      end if;
    elsif new.payment_status = 'REFUND_PENDING' then
      new.refund_requested_at := coalesce(new.refund_requested_at, v_now);
    elsif new.payment_status = 'REFUNDED' then
      new.refunded_at := coalesce(new.refunded_at, v_now);
    end if;
  end if;

  -- Refund rule. Runs AFTER the checks above on purpose:
  --  * a paid order that becomes CANCELLED/REJECTED is queued for refund, and
  --  * a payment that lands on an order which was ALREADY cancelled/rejected
  --    (e.g. the student paid at the last second) goes straight to refund.
  if new.status in ('CANCELLED', 'REJECTED') and new.payment_status = 'PAID' then
    new.payment_status      := 'REFUND_PENDING';
    new.refund_requested_at := coalesce(new.refund_requested_at, v_now);
  end if;

  return new;
end $$;

create trigger orders_20_lifecycle before update on public.orders
  for each row execute function private.orders_lifecycle();

-- 4.5 In-app notifications. SECURITY DEFINER because clients cannot insert
-- into notifications themselves.
create function private.orders_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_label text := coalesce('Order ' || new.order_number, 'Your order');
  v_type  text;
  v_title text;
begin
  -- Payment just succeeded on a live order: confirm to the student, alert the shop.
  if new.paid_at is not null and old.paid_at is null and new.status = 'PENDING' then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'order_placed',
            v_label || ' confirmed', 'Payment received. Waiting for the shop to accept.');

    insert into public.notifications (user_id, order_id, type, title, body)
    select p.id, new.id, 'new_order', 'New order ' || new.order_number, 'A new paid order is waiting.'
      from public.profiles p
     where p.shop_id = new.shop_id and p.role = 'shopkeeper' and p.deleted_at is null;
  end if;

  if new.status is distinct from old.status then
    case new.status
      when 'ACCEPTED'  then v_type := 'order_accepted';  v_title := v_label || ' was accepted';
      when 'PRINTING'  then v_type := 'order_printing';  v_title := v_label || ' is being printed';
      when 'READY'     then v_type := 'order_ready';     v_title := v_label || ' is ready for pickup';
      when 'COMPLETED' then v_type := 'order_completed'; v_title := v_label || ' is complete';
      when 'REJECTED'  then v_type := 'order_rejected';  v_title := v_label || ' was rejected';
      when 'CANCELLED' then v_type := 'order_cancelled'; v_title := v_label || ' was cancelled';
      else v_type := null;
    end case;

    if v_type is not null then
      insert into public.notifications (user_id, order_id, type, title, body)
      values (new.student_id, new.id, v_type, v_title, new.status_reason);
    end if;
  end if;

  if new.payment_status = 'REFUNDED' and old.payment_status is distinct from 'REFUNDED' then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_issued', 'Refund issued for ' || lower(v_label),
            'Your money is on its way back to you.');
  end if;

  return null;
end $$;

create trigger orders_90_notify after update on public.orders
  for each row execute function private.orders_notify();

-- -----------------------------------------------------------------------------
-- 5. RPC functions
-- -----------------------------------------------------------------------------

-- create_order: the ONLY way a student creates an order. The price is computed
-- here from shop_pricing — the client never supplies one.
--
-- p_files is a JSON array like:
--   [{"storage_path": "<user-id>/<upload-id>/<file>.pdf", "original_name": "notes.pdf",
--     "mime_type": "application/pdf", "size_bytes": 123456, "page_count": 12}]
-- Files must already be uploaded to the print-files bucket under the caller's id.
--
-- Afterwards the SERVER creates the Razorpay order and stores payment_order_id
-- (service role). Payment success then flips payment_status to PAID, which
-- assigns the order number.
create function public.create_order(
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
  v_uid    uuid := (select auth.uid());
  v_shop   public.shops;
  v_rate   int;
  v_pages  int := 0;
  v_sheets int := 0;
  v_file   jsonb;
  v_path   text;
  v_pc     int;
  v_order  public.orders;
begin
  if v_uid is null then
    raise exception 'Sign in to place an order' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles
                  where id = v_uid and role = 'student' and deleted_at is null) then
    raise exception 'Only students can place orders' using errcode = '42501';
  end if;

  select * into v_shop from public.shops
   where id = p_shop_id and deleted_at is null and is_verified;
  if not found then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;
  if not v_shop.is_open then
    raise exception 'This shop is closed right now' using errcode = 'P0001';
  end if;

  if p_copies is null or p_copies not between 1 and 20 then
    raise exception 'Copies must be between 1 and 20' using errcode = '22023';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) not between 1 and 10 then
    raise exception 'Attach between 1 and 10 files' using errcode = '22023';
  end if;

  select sp.price_paise into v_rate
    from public.shop_pricing sp
   where sp.shop_id = p_shop_id and sp.service = 'print'
     and sp.colour_mode = p_colour_mode and sp.paper_size = p_paper_size
     and sp.is_active and sp.deleted_at is null;
  if not found then
    raise exception 'This shop does not offer that print option' using errcode = 'P0002';
  end if;

  for v_file in select e from jsonb_array_elements(p_files) as e loop
    v_path := v_file ->> 'storage_path';
    v_pc   := (v_file ->> 'page_count')::int;

    -- A student may only attach files from their own upload folder.
    if v_path is null or split_part(v_path, '/', 1) <> v_uid::text then
      raise exception 'Invalid file path' using errcode = '42501';
    end if;
    if v_pc is null or v_pc < 1 then
      raise exception 'Invalid page count' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'print-files' and o.name = v_path) then
      raise exception 'File has not been uploaded: %', v_path using errcode = 'P0002';
    end if;

    v_pages  := v_pages + v_pc;
    -- Each file prints separately. Double-sided puts two pages on a sheet.
    v_sheets := v_sheets + case when p_sides = 'double' then (v_pc + 1) / 2 else v_pc end;
  end loop;
  v_sheets := v_sheets * p_copies;

  insert into public.orders (
    student_id, shop_id, colour_mode, paper_size, sides, copies,
    total_pages, sheets, rate_per_sheet_paise, total_paise, student_note
  ) values (
    v_uid, p_shop_id, p_colour_mode, p_paper_size, p_sides, p_copies,
    v_pages, v_sheets, v_rate, v_rate * v_sheets, nullif(btrim(p_student_note), '')
  ) returning * into v_order;

  insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count)
  select v_order.id, f ->> 'storage_path', f ->> 'original_name', f ->> 'mime_type',
         (f ->> 'size_bytes')::bigint, (f ->> 'page_count')::int
    from jsonb_array_elements(p_files) as f;

  return v_order;
end $$;

-- cancel_order: a student may cancel only while the order is still PENDING.
-- The lifecycle trigger queues a refund automatically if it was already paid.
create function public.cancel_order(p_order_id uuid) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders
   where id = p_order_id and student_id = (select auth.uid())
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

-- Auto-cancel orders still unpaid after 24 hours (scheduled in section 9).
-- Cancelling starts the 7-day file purge clock via the lifecycle trigger.
create function private.cancel_stale_unpaid_orders() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  with cancelled as (
    update public.orders
       set status = 'CANCELLED', status_reason = 'Not paid within 24 hours'
     where status = 'PENDING'
       and payment_status in ('PENDING', 'FAILED')
       and created_at < now() - interval '24 hours'
    returning 1
  )
  select count(*) into v_count from cancelled;
  return v_count;
end $$;

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
-- -----------------------------------------------------------------------------
-- Every table has RLS on, so anything without a matching policy is denied.
-- Policies are permissive and combine with OR. `(select auth.uid())` is wrapped
-- in a sub-select so Postgres evaluates it once per query, not once per row.

alter table public.profiles       enable row level security;
alter table public.shops          enable row level security;
alter table public.shop_pricing   enable row level security;
alter table public.orders         enable row level security;
alter table public.order_files    enable row level security;
alter table public.notifications  enable row level security;
alter table public.order_counters enable row level security;
alter table public.payment_events enable row level security;

-- profiles --------------------------------------------------------------------
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
-- Column limits (name + phone only) are enforced by profiles_guard.
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_admin_all on public.profiles for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- shops -----------------------------------------------------------------------
-- There is deliberately NO public/student policy on the shops TABLE: it holds
-- the phone number and other internal columns. Everyone browses shops through
-- the safe public.public_shops view (section 6b) instead.
create policy shops_select_own_shop on public.shops for select to authenticated
  using (id = private.my_shop_id());
-- Column limits (is_open + prep_minutes only) are enforced by shops_guard.
create policy shops_update_own_shop on public.shops for update to authenticated
  using (id = private.my_shop_id()) with check (id = private.my_shop_id());
create policy shops_admin_all on public.shops for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- shop_pricing — read-only for students and shopkeepers in the MVP ------------
-- Signed-in students may read the price list of any listed shop (they need it to
-- see the calculated price). Uses a helper because students cannot read the
-- shops table directly.
create policy shop_pricing_select_visible on public.shop_pricing for select to authenticated
  using (deleted_at is null and is_active and private.is_shop_listed(shop_id));
create policy shop_pricing_select_own_shop on public.shop_pricing for select to authenticated
  using (shop_id = private.my_shop_id());
create policy shop_pricing_admin_all on public.shop_pricing for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- orders ----------------------------------------------------------------------
-- No INSERT policy for students: orders are created through create_order().
create policy orders_select_own on public.orders for select to authenticated
  using (student_id = (select auth.uid()));
-- Shops only see orders that have been PAID. paid_at (not payment_status) is
-- used on purpose: payment_status moves to REFUND_PENDING when a shop rejects an
-- order, and the row must still pass this policy's WITH CHECK after that change.
create policy orders_select_shop on public.orders for select to authenticated
  using (shop_id = private.my_shop_id() and paid_at is not null);
-- Column limits (status + status_reason only) are enforced by orders_guard;
-- the allowed status moves by orders_lifecycle.
create policy orders_update_shop on public.orders for update to authenticated
  using (shop_id = private.my_shop_id() and paid_at is not null)
  with check (shop_id = private.my_shop_id() and paid_at is not null);
create policy orders_admin_all on public.orders for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- order_files -----------------------------------------------------------------
create policy order_files_select_student on public.order_files for select to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_files.order_id and o.student_id = (select auth.uid())));
create policy order_files_select_shop on public.order_files for select to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_files.order_id
                    and o.shop_id = private.my_shop_id() and o.paid_at is not null));
create policy order_files_admin_all on public.order_files for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- notifications ---------------------------------------------------------------
create policy notifications_select_own on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
-- Only read_at may change; enforced by notifications_guard.
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_admin_all on public.notifications for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- helper tables ---------------------------------------------------------------
create policy order_counters_admin_all on public.order_counters for all to authenticated
  using (private.is_admin()) with check (private.is_admin());
create policy payment_events_select_admin on public.payment_events for select to authenticated
  using (private.is_admin());

-- 6b. Public shop listing -----------------------------------------------------
-- What visitors (signed in or not) see on the "Find your print shop" list. It is
-- a view that exposes ONLY safe columns: no phone number, no user ids, no
-- admin or internal fields. Only verified, non-deleted shops appear.
--
-- security_invoker = false means the view reads the underlying tables with its
-- owner's rights, so it works for signed-out visitors even though they have no
-- access to those tables. That is the intent: the column list below is the
-- security boundary. Be careful when adding columns to it.
create view public.public_shops with (security_invoker = false) as
select
  s.id,
  s.slug,
  s.name,
  s.description,
  s.address,
  s.distance_metres,
  s.is_open,
  s.prep_minutes,
  s.sort_order,
  -- "From" prices in paise per sheet (cheapest active print option).
  (select min(p.price_paise) from public.shop_pricing p
    where p.shop_id = s.id and p.service = 'print' and p.colour_mode = 'bw'
      and p.is_active and p.deleted_at is null)     as bw_from_paise,
  (select min(p.price_paise) from public.shop_pricing p
    where p.shop_id = s.id and p.service = 'print' and p.colour_mode = 'colour'
      and p.is_active and p.deleted_at is null)     as colour_from_paise,
  -- Which services the shop offers, e.g. {print,photocopy,scanning}.
  coalesce((select array_agg(distinct p.service order by p.service)
              from public.shop_pricing p
             where p.shop_id = s.id and p.is_active and p.deleted_at is null),
           '{}'::text[])                            as services
from public.shops s
where s.deleted_at is null and s.is_verified
order by s.sort_order, s.name;

-- -----------------------------------------------------------------------------
-- 7. Privileges
-- -----------------------------------------------------------------------------
-- Supabase grants new tables to anon/authenticated by default. Start from zero
-- and grant only what is needed; RLS then narrows it by row. Signed-out
-- visitors (anon) get NO table access — only the public_shops view below.

revoke all on table
  public.profiles, public.shops, public.shop_pricing, public.orders,
  public.order_files, public.notifications, public.order_counters, public.payment_events
from anon, authenticated;

grant select, update                 on public.profiles       to authenticated;
grant select, insert, update, delete on public.shops          to authenticated;
grant select, insert, update, delete on public.shop_pricing   to authenticated;
grant select, insert, update         on public.orders         to authenticated; -- orders are never deleted
grant select, insert, update, delete on public.order_files    to authenticated;
grant select, insert, update, delete on public.notifications  to authenticated;
grant select, insert, update, delete on public.order_counters to authenticated;
grant select                         on public.payment_events to authenticated;
-- (Insert/delete grants above are only ever usable by admins: no other role has
--  a matching policy.)

-- The public shop list: readable by anyone, including signed-out visitors.
revoke all on public.public_shops from public, anon, authenticated;
grant select on public.public_shops to anon, authenticated;

-- Internal helpers: callable by signed-in users only where policies need them.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_admin()               to authenticated;
grant execute on function private.my_shop_id()             to authenticated;
grant execute on function private.is_shop_listed(uuid)     to authenticated;
grant execute on function private.shop_can_read_file(text) to authenticated;

-- RPC functions: signed-in users only.
revoke execute on function public.create_order(uuid, text, text, text, int, jsonb, text) from public, anon;
revoke execute on function public.cancel_order(uuid) from public, anon;
grant  execute on function public.create_order(uuid, text, text, text, int, jsonb, text) to authenticated;
grant  execute on function public.cancel_order(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Storage: private bucket for uploaded documents
-- -----------------------------------------------------------------------------
-- Path convention:  <student-user-id>/<upload-id>/<file-uuid>.<ext>
-- The first folder is the uploader's auth id; the policies below key off it.
-- Files are never public: the app hands out short-lived signed URLs.
-- Students cannot update or delete files; the purge job (service role, via the
-- Storage API) deletes them 7 days after the order is final.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('print-files', 'print-files', false, 26214400,
        array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

create policy print_files_insert_own on storage.objects for insert to authenticated
  with check (
    bucket_id = 'print-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy print_files_select_own on storage.objects for select to authenticated
  using (
    bucket_id = 'print-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- A shopkeeper can read a file only if it belongs to a paid order of their shop.
create policy print_files_select_shop on storage.objects for select to authenticated
  using (bucket_id = 'print-files' and private.shop_can_read_file(name));

create policy print_files_admin_all on storage.objects for all to authenticated
  using (bucket_id = 'print-files' and private.is_admin())
  with check (bucket_id = 'print-files' and private.is_admin());

-- -----------------------------------------------------------------------------
-- 9. Scheduled job: cancel orders left unpaid for 24 hours
-- -----------------------------------------------------------------------------
-- Runs every 10 minutes. If pg_cron is unavailable the migration still
-- succeeds; schedule private.cancel_stale_unpaid_orders() some other way.
--
-- NOT scheduled here: the file-purge worker. It needs your project URL and a
-- service key, which don't belong in a migration. It should be an Edge Function
-- that, using the service role, (a) deletes the stored files of orders where
-- files_purge_after < now() and files_purged_at is null, then sets
-- order_files.file_deleted_at and orders.files_purged_at, and (b) deletes
-- uploads older than 24h that were never attached to an order. original_name
-- and the other order_files metadata are kept.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'campusprint-cancel-unpaid-orders',
      '*/10 * * * *',
      $job$select private.cancel_stale_unpaid_orders()$job$
    );
  else
    raise notice 'pg_cron is not available; schedule private.cancel_stale_unpaid_orders() manually';
  end if;
end $$;

commit;

-- =============================================================================
-- 10. Adding the first shops, an admin and shopkeepers (run by hand in the
--     Supabase SQL editor AFTER this migration; not part of the migration).
--     The SQL editor runs as `postgres`, which the guard triggers trust.
--
--     THIS MIGRATION NEVER CREATES AUTH USERS. Steps (c) and (d) need a login
--     that already exists: create it first in the Supabase Dashboard
--     (Authentication -> Users -> Add user) or by signing up in the app. The
--     signup trigger gives it a 'student' profile; (c)/(d) then promote it.
--     Replace every <placeholder> below with the real value.
-- =============================================================================
--
-- -- a) Shops (4–5 of them). Prices are paise per sheet: 200 = ₹2.00.
-- insert into public.shops
--   (name, slug, order_prefix, address, distance_metres, is_verified, is_open, prep_minutes, sort_order)
-- values
--   ('ABC Xerox', 'abc-xerox', 'A', 'Near Main Gate', 150, true, true, 10, 10);
--
-- -- b) Prices for that shop (4 rows: B&W/Colour x A4/A3).
-- insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise)
-- select s.id, 'print', v.colour_mode, v.paper_size, v.price_paise
--   from public.shops s,
--        (values ('bw','a4',200), ('bw','a3',400), ('colour','a4',1000), ('colour','a3',2000))
--          as v(colour_mode, paper_size, price_paise)
--  where s.slug = 'abc-xerox';
--
-- -- c) Make yourself an admin (after creating your Auth user; find its id under
-- --    Authentication -> Users).
-- update public.profiles set role = 'admin' where id = '<your-auth-user-id>';
--
-- -- d) Turn an existing Auth user into a shopkeeper (create the Auth user first).
-- --    role and shop_id MUST be set together.
-- update public.profiles
--    set role = 'shopkeeper', shop_id = (select id from public.shops where slug = 'abc-xerox')
--  where id = '<shopkeeper-auth-user-id>';
