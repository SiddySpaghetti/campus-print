-- =============================================================================
-- CampusPrint — printing starts only when the shopkeeper confirms it
-- =============================================================================
-- Step 3 of 3. NOT in supabase/migrations on purpose. Apply only after production verification, and once no running app version calls start_printing
-- (the download route stopped doing so in the deploy before step 2).
-- orders_guard: same logic, corrected message. start_printing is gone, so
-- confirm_printing (which needs a recorded hand-over) is the one way in.
-- =============================================================================

begin;

drop function public.start_printing(uuid, uuid);

create or replace function private.orders_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Printing starts only through public.confirm_printing (runs as its owner),
  -- which POST /api/shop/orders/[id]/printing calls after authorising the
  -- shopkeeper. No API role can set it directly: not a shopkeeper, student or
  -- admin session, and not a raw service-role PATCH either.
  if new.status = 'PRINTING' and old.status is distinct from 'PRINTING'
     and current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'Printing starts when the shop confirms it' using errcode = '42501';
  end if;

  if current_user in ('authenticated', 'anon', 'service_role')
     and (to_jsonb(new) - array['status', 'status_reason']::text[])
         is distinct from (to_jsonb(old) - array['status', 'status_reason']::text[]) then
    raise exception 'Only the order status can be changed here' using errcode = '42501';
  end if;

  if current_user not in ('authenticated', 'anon') or private.is_admin() then
    return new;
  end if;
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
