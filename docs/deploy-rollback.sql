-- =============================================================================
-- CampusPrint — rollback for the 20261025 release (manual, SQL editor)
-- =============================================================================
-- NOT a migration (it lives outside supabase/migrations on purpose). Run one
-- section at a time, only when the deployment plan says so.
--
-- No rollback is needed for:
--   20261025120000_print_on_download      (the old app works with it)
--   20261025120200_payment_reconciliation (the old app works with it; undoing
--                                          it would bring back "any refund =
--                                          fully refunded")
-- =============================================================================


-- A. Undo 20261025120100_printing_only_via_download ----------------------------
-- Only when the APP is rolled back to the version with the "Start printing"
-- button: that version sets PRINTING as the shopkeeper, which this migration
-- refuses. Restores orders_guard exactly as in 20261002224052 and removes the
-- insert guard. Afterwards record it, so a later `supabase db push` re-applies
-- the migration:  supabase migration repair --status reverted 20261025120100
begin;

create or replace function private.orders_guard() returns trigger
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

drop trigger if exists orders_10_insert_guard on public.orders;
drop function if exists private.orders_insert_guard();

commit;


-- B. Undo the pilot DATA of 20261025120300_pilot_shops_and_k2_page_pricing -----
-- The schema stays (both app versions work with it). Lists every shop again,
-- as before the migration (only rows it unlisted change; Sitaram and K2 are
-- untouched), and drops K2's per-page tiers so new K2 orders are priced per
-- sheet again. Orders already priced per page keep their stored totals.
begin;

update public.shops set listed = true where not listed;
delete from public.shop_page_price_tiers;

commit;


-- Forward again (after the fix is redeployed) ----------------------------------
-- After A:  supabase migration repair --status reverted 20261025120100
--           supabase db push --include-all     (it sorts before applied ones)
-- After B:  re-run the pilot data, exactly as 20261025120300 does:
begin;

update public.shops set listed = false
 where slug not in ('k2-print-store', 'sitaram-prints')
   and exists (select 1 from public.shops where slug = 'k2-print-store')
   and exists (select 1 from public.shops where slug = 'sitaram-prints');

insert into public.shop_page_price_tiers (shop_id, colour_mode, paper_size, min_pages, price_paise)
select s.id, 'bw', 'a4', t.min_pages, t.price_paise
  from public.shops s, (values (1, 500), (4, 300), (9, 200)) as t (min_pages, price_paise)
 where s.slug = 'k2-print-store'
on conflict do nothing;

commit;
