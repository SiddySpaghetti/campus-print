-- ROLLBACK of 20261103120200_printing_only_via_confirm. Manual, SQL editor.
-- Then: supabase migration repair --status reverted 20261103120200
begin;

create function public.start_printing(p_order_id uuid, p_shop_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders
     set status = 'PRINTING'
   where id = p_order_id
     and shop_id = p_shop_id
     and (status = 'ACCEPTED' or (status = 'PENDING' and payment_method = 'ONLINE'));
  return found;
end $$;

revoke all on function public.start_printing(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_printing(uuid, uuid) to service_role;

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

commit;
