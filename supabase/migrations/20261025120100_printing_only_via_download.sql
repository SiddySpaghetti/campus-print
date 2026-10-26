-- =============================================================================
-- CampusPrint — only the download route can start printing
-- =============================================================================
-- Step 2 of 2. Apply AFTER the app deploy that ships the download route: the old
-- app's "Start printing" button sets PRINTING as the shopkeeper and would be
-- refused from here on.
--
-- Before: any shopkeeper session could PATCH its own order to PRINTING through
-- PostgREST directly (and admins anything). Now orders_guard refuses a change to
-- PRINTING from every API role (anon, authenticated — admins included — and
-- service_role), so it can come only from public.start_printing (SECURITY
-- DEFINER, executable by service_role only, called by the download route) or
-- the database owner (SQL editor).
-- Also: every API role — admin sessions included, which the old guard trusted —
-- may change only status/status_reason (never payment state, amounts or
-- pricing), and no API role may insert an order (see the insert guard).
-- Admins keep the order lifecycle (reject/cancel/ready/collected), and all
-- shop, pricing and profile administration; nothing in the app needs more.
-- =============================================================================

begin;

create or replace function private.orders_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Printing starts only through public.start_printing (runs as its owner),
  -- which POST /api/shop/files/[id] calls after authorising the shopkeeper and
  -- signing the download. No API role can set it directly: not a shopkeeper,
  -- student or admin session, and not a raw service-role PATCH either.
  if new.status = 'PRINTING' and old.status is distinct from 'PRINTING'
     and current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'Printing starts when the shop downloads the document' using errcode = '42501';
  end if;

  -- Every API role (shopkeeper and admin sessions — orders_admin_all — and a raw
  -- service-role PATCH) may change only status and status_reason. Payment
  -- state, amounts, refunds and pricing change only inside the SECURITY
  -- DEFINER payment/order functions (run as owner) and the lifecycle trigger,
  -- so "paid" and "refunded" always come from a verified, recorded event. A
  -- whitelist, so columns added later are protected too.
  if current_user in ('authenticated', 'anon', 'service_role')
     and (to_jsonb(new) - array['status', 'status_reason']::text[])
         is distinct from (to_jsonb(old) - array['status', 'status_reason']::text[]) then
    raise exception 'Only the order status can be changed here' using errcode = '42501';
  end if;

  if current_user not in ('authenticated', 'anon') or private.is_admin() then
    return new;
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

-- The update guard can't see INSERTs, and orders_admin_all (FOR ALL) plus the
-- insert grant let an admin session create a row directly — already PRINTING,
-- or already PAID at any price — skipping verification entirely. Orders are
-- only ever created by create_order_verified (SECURITY DEFINER, runs as its
-- owner, after the server inspected the files), so no API role inserts orders.
create function private.orders_insert_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'Orders are created only by create_order_verified' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger orders_10_insert_guard before insert on public.orders
  for each row execute function private.orders_insert_guard();

commit;
