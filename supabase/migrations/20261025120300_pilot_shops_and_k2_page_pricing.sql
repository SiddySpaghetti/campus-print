-- =============================================================================
-- CampusPrint — pilot shop list and K2's per-page B&W pricing
-- =============================================================================
-- 1. shops.listed (admin-only; shops_guard keeps shopkeepers off it): false =
--    the shop takes no NEW orders. create_order_verified refuses it (server-side,
--    whatever the browser sends); public_shops exposes the flag so the app hides
--    the shop from the picker and landing page, while past orders keep showing
--    its name. Orders, payments, pricing and verification flags are untouched.
--    For the pilot only K2 Print Store and Sitaram Prints stay listed; the
--    update runs only where both exist (i.e. production), so a fresh database
--    is unaffected. Sitaram's row is not changed (listed stays true).
-- 2. shop_page_price_tiers: per-page rates by billable pages (pages x copies).
--    Seeded for K2 only, A4 B&W only: 1-3 pages Rs5, 4-8 Rs3, 9+ Rs2. Every
--    other shop, A3 and colour keep per-sheet pricing from shop_pricing.
--    public_shops.page_tiers exposes them so shop cards show per-page rates.
-- 3. orders.pricing_unit ('sheet' | 'page'): how total_paise was computed.
--    Existing orders are 'sheet' and keep their stored prices; the total check
--    now reads: total = rate x (pages x copies) for 'page', rate x sheets else.
--    (rate_per_sheet_paise holds the per-page rate for 'page' orders.)
-- Apply after the app deploy that reads public_shops.listed and the tiers (the
-- app tolerates both being absent, so the order is flexible).
-- =============================================================================

begin;

-- 1. Pilot shop list ----------------------------------------------------------
alter table public.shops add column listed boolean not null default true;

update public.shops set listed = false
 where slug not in ('k2-print-store', 'sitaram-prints')
   and exists (select 1 from public.shops where slug = 'k2-print-store')
   and exists (select 1 from public.shops where slug = 'sitaram-prints');

-- 2. Per-page tiers ------------------------------------------------------------
create table public.shop_page_price_tiers (
  shop_id     uuid not null references public.shops (id) on delete cascade,
  colour_mode text not null check (colour_mode in ('bw', 'colour')),
  paper_size  text not null check (paper_size in ('a4', 'a3')),
  min_pages   int  not null check (min_pages between 1 and 100000),
  price_paise int  not null check (price_paise > 0),
  primary key (shop_id, colour_mode, paper_size, min_pages)
);
alter table public.shop_page_price_tiers enable row level security;
revoke all on table public.shop_page_price_tiers from anon, authenticated;
grant select, insert, update, delete on public.shop_page_price_tiers to authenticated;
-- Same visibility as shop_pricing: signed-in users see listed shops' rates,
-- shopkeepers their own; only admins write.
create policy shop_page_price_tiers_select_visible on public.shop_page_price_tiers
  for select to authenticated using (private.is_shop_listed(shop_id));
create policy shop_page_price_tiers_select_own_shop on public.shop_page_price_tiers
  for select to authenticated using (shop_id = private.my_shop_id());
create policy shop_page_price_tiers_admin_all on public.shop_page_price_tiers
  for all to authenticated using (private.is_admin()) with check (private.is_admin());

insert into public.shop_page_price_tiers (shop_id, colour_mode, paper_size, min_pages, price_paise)
select s.id, 'bw', 'a4', t.min_pages, t.price_paise
  from public.shops s, (values (1, 500), (4, 300), (9, 200)) as t (min_pages, price_paise)
 where s.slug = 'k2-print-store';

-- public_shops (after the tiers table it reads) ---------------------------------
create or replace view public.public_shops with (security_invoker = false) as
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
           '{}'::text[])                            as services,
  -- Pilot switch (admin-only): false = no new orders. Exposed instead of
  -- filtered so students' past orders still show the shop's name.
  s.listed,
  -- Per-page tiers ([{colour_mode, paper_size, min_pages, price_paise}]), so
  -- the shop card can show K2's "Rs2-Rs5/page" instead of a per-sheet "from".
  -- Public prices, like the "from" columns above (signed-out visitors read only
  -- this view).
  coalesce((select jsonb_agg(jsonb_build_object('colour_mode', t.colour_mode, 'paper_size', t.paper_size,
                                                'min_pages', t.min_pages, 'price_paise', t.price_paise)
                             order by t.colour_mode, t.paper_size, t.min_pages)
              from public.shop_page_price_tiers t
             where t.shop_id = s.id),
           '[]'::jsonb)                             as page_tiers
from public.shops s
where s.deleted_at is null and s.is_verified
order by s.sort_order, s.name;

-- Owner rights on purpose (see 20261012103724_restore_public_shops_definer_view).
alter view public.public_shops set (security_invoker = false);

-- 3. Orders record how they were priced -----------------------------------------
alter table public.orders
  add column pricing_unit text not null default 'sheet' check (pricing_unit in ('sheet', 'page'));
alter table public.orders drop constraint orders_total_matches_rate;
alter table public.orders add constraint orders_total_matches_rate check (
  total_paise = rate_per_sheet_paise * case pricing_unit when 'page' then total_pages * copies else sheets end
);

-- create_order_verified: refuses unlisted shops; prices by tier when one
-- applies (otherwise identical to 20261008190514_pay_at_counter.sql).
create or replace function public.create_order_verified(
  p_user_id        uuid,
  p_shop_id        uuid,
  p_colour_mode    text,
  p_paper_size     text,
  p_sides          text,
  p_copies         int,
  p_files          jsonb,
  p_student_note   text default null,
  p_payment_method text default 'ONLINE'
) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  c_uuid   constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_shop   public.shops;
  v_rate   int;
  v_pages  int := 0;
  v_sheets int := 0;
  v_tier   int;
  v_unit   text := 'sheet';
  v_file   jsonb;
  v_path   text;
  v_ext    text;
  v_mime   text;
  v_size   bigint;
  v_pc     int;
  v_existing public.orders;
  v_order  public.orders;
  v_date   date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_user_id is null then
    raise exception 'Sign in to place an order' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles
                  where id = p_user_id and role = 'student' and deleted_at is null) then
    raise exception 'Only students can place orders' using errcode = '42501';
  end if;
  if p_payment_method is null or p_payment_method not in ('ONLINE', 'PAY_AT_COUNTER') then
    raise exception 'Invalid payment method' using errcode = '22023';
  end if;

  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) not between 1 and 10 then
    raise exception 'Attach between 1 and 10 files' using errcode = '22023';
  end if;

  -- Idempotent retry: if the first file is already attached to one of THIS
  -- user's still-unpaid PENDING orders, return that order instead of duplicating.
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
   where id = p_shop_id and deleted_at is null and is_verified and listed;
  if not found then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;
  if not v_shop.is_open then
    raise exception 'This shop is closed right now' using errcode = 'P0001';
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
    if jsonb_typeof(v_file) <> 'object' then
      raise exception 'Invalid file' using errcode = '22023';
    end if;
    v_path := v_file ->> 'storage_path';
    v_mime := v_file ->> 'mime_type';

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
    if (v_mime <> 'application/pdf' and v_pc <> 1) or v_pc not between 1 and 500 then
      raise exception 'Invalid page count' using errcode = '22023';
    end if;

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

  -- Per-page tiers (K2's A4 B&W): the rate depends on the billable pages —
  -- server-counted pages x copies — and the total is rate x those pages.
  -- Without tiers for this shop/colour/paper, per-sheet pricing as before.
  select t.price_paise into v_tier
    from public.shop_page_price_tiers t
   where t.shop_id = p_shop_id and t.colour_mode = p_colour_mode and t.paper_size = p_paper_size
     and t.min_pages <= v_pages * p_copies
   order by t.min_pages desc
   limit 1;
  if v_tier is not null then
    v_rate := v_tier;
    v_unit := 'page';
  end if;

  insert into public.orders (
    student_id, shop_id, colour_mode, paper_size, sides, copies,
    total_pages, sheets, rate_per_sheet_paise, total_paise, student_note,
    payment_method, order_date, order_number, pricing_unit
  ) values (
    p_user_id, p_shop_id, p_colour_mode, p_paper_size, p_sides, p_copies,
    v_pages, v_sheets, v_rate, v_rate * (case when v_unit = 'page' then v_pages * p_copies else v_sheets end), left(nullif(btrim(p_student_note), ''), 500),
    p_payment_method, v_date,
    case when p_payment_method = 'PAY_AT_COUNTER'
         then private.next_order_number(p_shop_id, v_date) end
    , v_unit
  ) returning * into v_order;

  insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count)
  select v_order.id, f ->> 'storage_path',
         coalesce(nullif(left(regexp_replace(coalesce(f ->> 'original_name', ''), '[\x00-\x1f\x7f/\\]', '_', 'g'), 255), ''), 'document'),
         f ->> 'mime_type', (f ->> 'size_bytes')::bigint, (f ->> 'page_count')::int
    from jsonb_array_elements(p_files) as f;

  return v_order;
end $$;

commit;
