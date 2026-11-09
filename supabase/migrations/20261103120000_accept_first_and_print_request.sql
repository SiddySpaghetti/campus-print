-- =============================================================================
-- CampusPrint — accept-then-pay, confirmed printing, ordered multi-file orders
-- =============================================================================
-- Step 1 of 3. Apply only with explicit approval. Safe BEFORE the app deploy: orders.accept_first defaults
-- to FALSE here, so every order keeps today's pay-first flow until step 2 flips
-- the default. Existing rows get FALSE without being rewritten and stay pay-first
-- for life.
--
--   ONLINE, accept_first:  PENDING -> ACCEPTED -> (paid) -> PRINTING -> READY -> COMPLETED
--   ONLINE, legacy:        PENDING -> (paid) -> PRINTING -> READY -> COMPLETED
--   PAY_AT_COUNTER:        PENDING -> ACCEPTED -> PRINTING -> READY -> COMPLETED (unchanged)
--
-- No enum changes. Shops see an accept_first order's metadata before payment;
-- private.shop_can_read_file is deliberately NOT touched, so the file BYTES of
-- an unpaid online order stay unreadable to the shop at the Storage policy.
--
-- Late payments: a payment landing on a cancelled or rejected order never reopens
-- it; it goes to REFUND_PENDING and paid_after_cancel records the fact, set under
-- the same row lock as process_payment_event's paid_after_cancel result. Lifecycle
-- timestamps use clock_timestamp() instead of now() (the transaction's START), so
-- they follow the order rows were really locked in.
-- =============================================================================

begin;

alter table public.orders
  add column accept_first boolean not null default false,
  add column print_requested_at timestamptz,
  add column paid_after_cancel boolean not null default false;

-- Late payments already on record. Only these rows are written, and orders_notify
-- sends nothing for them (paid_at is unchanged). Old events have no recorded result,
-- so their timestamps decide; a payment before the cancellation is not flagged.
update public.orders o
   set paid_after_cancel = true
 where o.status in ('CANCELLED', 'REJECTED')
   and o.paid_at is not null
   and (o.paid_at > coalesce(o.cancelled_at, o.rejected_at)
        or exists (select 1 from public.payment_events e
                    where e.order_id = o.id and e.result = 'paid_after_cancel'));

-- Schema-level invariant on top of orders_lifecycle.
alter table public.orders
  add constraint orders_work_requires_payment check (
    status not in ('PRINTING', 'READY', 'COMPLETED')
    or paid_at is not null
    or payment_method = 'PAY_AT_COUNTER'
  ) not valid;
alter table public.orders validate constraint orders_work_requires_payment;

alter table public.order_files add column sort_order int not null default 0 check (sort_order >= 0);
-- The API has always accepted several files per order: number any that exist, in
-- the order they were added, or the unique index below would refuse them.
update public.order_files f
   set sort_order = x.position
  from (select id, (row_number() over (partition by order_id order by created_at, id) - 1)::int as position
          from public.order_files) x
 where f.id = x.id and x.position > 0;
-- Also covers lookups by order_id, so the single-column index is redundant.
create unique index order_files_order_sort_key on public.order_files (order_id, sort_order);
drop index public.order_files_order_idx;

-- 1. Shop visibility of accept_first orders (metadata only) -----------------------
drop policy orders_select_shop on public.orders;
create policy orders_select_shop on public.orders for select to authenticated
  using (shop_id = (select private.my_shop_id())
         and (paid_at is not null or payment_method = 'PAY_AT_COUNTER' or accept_first));

drop policy orders_update_shop on public.orders;
create policy orders_update_shop on public.orders for update to authenticated
  using (shop_id = (select private.my_shop_id())
         and (paid_at is not null or payment_method = 'PAY_AT_COUNTER' or accept_first))
  with check (shop_id = (select private.my_shop_id())
         and (paid_at is not null or payment_method = 'PAY_AT_COUNTER' or accept_first));

drop policy order_files_select_shop on public.order_files;
create policy order_files_select_shop on public.order_files for select to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_files.order_id
                    and o.shop_id = (select private.my_shop_id())
                    and (o.paid_at is not null or o.payment_method = 'PAY_AT_COUNTER' or o.accept_first)));

-- 2. Lifecycle -------------------------------------------------------------------
create or replace function private.orders_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- The row is locked by the time this runs, so these follow the real order of
  -- events. now() is when the transaction started: a payment waiting on a
  -- cancellation's lock would be stamped earlier than the cancellation.
  v_now timestamptz := clock_timestamp();
begin
  if new.payment_method is distinct from old.payment_method
     or new.accept_first is distinct from old.accept_first then
    raise exception 'The payment method cannot change' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'PENDING'  and new.status in ('ACCEPTED', 'REJECTED', 'CANCELLED'))
      -- Legacy pay-first online orders only: they skip Accept.
      or (old.status = 'PENDING'  and new.status = 'PRINTING' and new.payment_method = 'ONLINE' and not new.accept_first)
      or (old.status = 'ACCEPTED' and new.status in ('PRINTING', 'CANCELLED'))
      or (old.status = 'PRINTING' and new.status in ('READY', 'CANCELLED'))
      or (old.status = 'READY'    and new.status = 'COMPLETED')
    ) then
      raise exception 'Invalid order status change: % -> %', old.status, new.status
        using errcode = '23514';
    end if;

    -- An accept_first order may be ACCEPTED unpaid (that is what unlocks payment).
    -- Nothing online is ever worked on unpaid. Counter orders are paid in person.
    if new.payment_status <> 'PAID'
       and new.payment_method <> 'PAY_AT_COUNTER'
       and (new.status in ('PRINTING', 'READY', 'COMPLETED')
            or (new.status = 'ACCEPTED' and not new.accept_first)) then
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

    if new.status in ('COMPLETED', 'CANCELLED', 'REJECTED') then
      new.files_purge_after := v_now + interval '7 days';
    end if;
  end if;

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
      -- The order stays closed; the refund rule below moves the payment on.
      if new.status in ('CANCELLED', 'REJECTED') then
        new.paid_after_cancel := true;
      end if;
      if new.order_number is null then
        new.order_date   := (v_now at time zone 'Asia/Kolkata')::date;
        new.order_number := private.next_order_number(new.shop_id, new.order_date);
      end if;
    elsif new.payment_status = 'REFUND_PENDING' then
      new.refund_requested_at := coalesce(new.refund_requested_at, v_now);
    elsif new.payment_status = 'REFUNDED' then
      new.refunded_at := coalesce(new.refunded_at, v_now);
    end if;
  end if;

  if new.status in ('CANCELLED', 'REJECTED') and new.payment_status = 'PAID' then
    new.payment_status      := 'REFUND_PENDING';
    new.refund_requested_at := coalesce(new.refund_requested_at, v_now);
  end if;

  return new;
end $$;

-- 3. Notifications ---------------------------------------------------------------
create or replace function private.orders_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_label text := coalesce('Order ' || new.order_number, 'Your order');
  v_type  text;
  v_title text;
  v_total text := '₹' || to_char(new.total_paise / 100.0, 'FM999999990.00');
  v_closed text := case new.status when 'REJECTED' then 'rejected' else 'cancelled' end;
begin
  -- Payment just succeeded on a live order: confirm to the student, alert the shop.
  -- An accept_first order is ACCEPTED by now, and the shop already had new_order.
  if new.paid_at is not null and old.paid_at is null and new.status in ('PENDING', 'ACCEPTED') then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'order_placed',
            v_label || ' confirmed', 'Payment received. The shop will print it soon.');

    insert into public.notifications (user_id, order_id, type, title, body)
    select p.id, new.id,
           case when new.accept_first then 'order_paid' else 'new_order' end,
           case when new.accept_first then 'Order ' || new.order_number || ' is paid' else 'New order ' || new.order_number end,
           case when new.accept_first then 'Payment confirmed. It is ready to print.' else 'A new paid order is waiting.' end
      from public.profiles p
     where p.shop_id = new.shop_id and p.role = 'shopkeeper' and p.deleted_at is null;
  end if;

  if new.paid_at is not null and old.paid_at is null and new.status in ('CANCELLED', 'REJECTED') then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'payment_after_cancel', v_label || ' was paid after it was ' || v_closed,
            'Nothing was printed. Your payment of ' || v_total || ' is recorded and has not been refunded. To request a refund, contact the shop.');

    insert into public.notifications (user_id, order_id, type, title, body)
    select p.id, new.id, 'payment_after_cancel', 'Payment received for ' || v_closed || ' order ' || new.order_number,
           'Nothing was printed and nothing has been refunded. Settle it with the student (Paid, not completed).'
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
      values (new.student_id, new.id, v_type, v_title,
              case when new.status in ('CANCELLED', 'REJECTED') and new.payment_status = 'REFUND_PENDING'
                   then concat_ws(' ', new.status_reason, 'Your payment is recorded and has not been refunded. To request a refund, contact the shop.')
                   when new.status = 'ACCEPTED' and new.payment_method = 'ONLINE' and new.payment_status <> 'PAID'
                   then 'Pay ' || v_total || ' now to send it to the printer.'
                   else new.status_reason end);
    end if;
  end if;

  if new.refunded_paise > old.refunded_paise and new.refunded_paise < new.total_paise then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_partial', 'Partial refund for ' || lower(v_label),
            'Razorpay confirmed a refund of ₹' || to_char((new.refunded_paise - old.refunded_paise) / 100.0, 'FM999999990.00')
            || '. ₹' || to_char((new.total_paise - new.refunded_paise) / 100.0, 'FM999999990.00')
            || ' of your payment has not been refunded; to request it, contact the shop.');
  end if;

  if (new.payment_status = 'REFUNDED' and old.payment_status is distinct from 'REFUNDED')
     or (new.payment_status <> 'REFUNDED' and new.refunded_paise = new.total_paise
         and old.refunded_paise < new.total_paise) then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_issued', 'Refund issued for ' || lower(v_label),
            'Your money is on its way back to you.');
  end if;

  return null;
end $$;

create or replace function private.orders_notify_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_counter boolean := new.payment_method = 'PAY_AT_COUNTER';
  -- An online order has no number until it is paid: same short id as orderLabel().
  v_label   text := coalesce(new.order_number, upper(left(new.id::text, 8)));
begin
  insert into public.notifications (user_id, order_id, type, title, body)
  values (new.student_id, new.id, 'order_placed',
          coalesce('Order ' || new.order_number, 'Your order') || ' placed',
          case when v_counter
               then 'Pay at the counter when you collect it. You''ll hear here when the shop accepts it.'
               else 'Nothing to pay yet. You can pay once the shop accepts it.' end);

  insert into public.notifications (user_id, order_id, type, title, body)
  select p.id, new.id, 'new_order', 'New order ' || v_label,
         case when v_counter
              then 'Pay at the counter. Accept it to start printing.'
              else 'Accept or reject it. The student pays after you accept.' end
    from public.profiles p
   where p.shop_id = new.shop_id and p.role = 'shopkeeper' and p.deleted_at is null;

  return null;
end $$;

drop trigger orders_90_notify_created on public.orders;
create trigger orders_90_notify_created after insert on public.orders
  for each row when (new.payment_method = 'PAY_AT_COUNTER' or new.accept_first)
  execute function private.orders_notify_created();

-- 4. Pricing: one implementation for create_order_verified and quote_order --------
create function private.price_order(
  p_shop_id uuid, p_colour_mode text, p_paper_size text, p_sides text, p_copies int, p_pages int[]
) returns table (o_unit text, o_rate int, o_pages int, o_sheets int, o_total int)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rate   int;
  v_tier   int;
  v_pages  int;
  v_sheets int;
begin
  select sp.price_paise into v_rate
    from public.shop_pricing sp
   where sp.shop_id = p_shop_id and sp.service = 'print'
     and sp.colour_mode = p_colour_mode and sp.paper_size = p_paper_size
     and sp.is_active and sp.deleted_at is null;
  if not found then
    raise exception 'This shop does not offer that print option' using errcode = 'P0002';
  end if;

  -- Each document starts on a new sheet, so double-sided rounds per document.
  select coalesce(sum(pc), 0), coalesce(sum(case when p_sides = 'double' then (pc + 1) / 2 else pc end), 0)
    into v_pages, v_sheets
    from unnest(p_pages) as pc;
  v_sheets := v_sheets * p_copies;

  select t.price_paise into v_tier
    from public.shop_page_price_tiers t
   where t.shop_id = p_shop_id and t.colour_mode = p_colour_mode and t.paper_size = p_paper_size
     and t.min_pages <= v_pages * p_copies
   order by t.min_pages desc
   limit 1;

  if v_tier is not null then
    return query select 'page'::text, v_tier, v_pages, v_sheets, v_tier * v_pages * p_copies;
  else
    return query select 'sheet'::text, v_rate, v_pages, v_sheets, v_rate * v_sheets;
  end if;
end $$;
revoke all on function private.price_order(uuid, text, text, text, int, int[]) from public, anon, authenticated;

-- The server-calculated price shown BEFORE an order is placed. The caller (POST
-- /api/orders/quote) has counted p_pages itself from the stored bytes.
create function public.quote_order(
  p_shop_id uuid, p_colour_mode text, p_paper_size text, p_sides text, p_copies int, p_pages int[]
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_price record;
begin
  if p_colour_mode is null or p_colour_mode not in ('bw', 'colour')
     or p_paper_size is null or p_paper_size not in ('a4', 'a3')
     or p_sides is null or p_sides not in ('single', 'double')
     or p_copies is null or p_copies not between 1 and 20
     or p_pages is null or cardinality(p_pages) not between 1 and 10 then
    raise exception 'Invalid print options' using errcode = '22023';
  end if;
  if not exists (select 1 from public.shops s
                  where s.id = p_shop_id and s.deleted_at is null and s.is_verified and s.listed and s.is_open) then
    raise exception 'Shop not available' using errcode = 'P0002';
  end if;
  select * into v_price from private.price_order(p_shop_id, p_colour_mode, p_paper_size, p_sides, p_copies, p_pages);
  return jsonb_build_object('unit', v_price.o_unit, 'ratePaise', v_price.o_rate, 'totalPages', v_price.o_pages,
                            'sheets', v_price.o_sheets, 'totalPaise', v_price.o_total);
end $$;
revoke all on function public.quote_order(uuid, text, text, text, int, int[]) from public, anon, authenticated;
grant execute on function public.quote_order(uuid, text, text, text, int, int[]) to service_role;

-- 5. create_order_verified: shared pricing, stored file order, 100 MB per order ---
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
  v_price  record;
  v_counts int[] := '{}';
  v_pages  int := 0;
  v_bytes  bigint := 0;
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
    v_bytes  := v_bytes + v_size;
    v_counts := v_counts || v_pc;
  end loop;

  if v_pages > 1000 then
    raise exception 'Too many pages' using errcode = '22023';
  end if;
  if v_bytes > 104857600 then
    raise exception 'Order too large' using errcode = '22023';
  end if;

  select * into v_price from private.price_order(p_shop_id, p_colour_mode, p_paper_size, p_sides, p_copies, v_counts);

  insert into public.orders (
    student_id, shop_id, colour_mode, paper_size, sides, copies,
    total_pages, sheets, rate_per_sheet_paise, total_paise, student_note,
    payment_method, order_date, order_number, pricing_unit
  ) values (
    p_user_id, p_shop_id, p_colour_mode, p_paper_size, p_sides, p_copies,
    v_price.o_pages, v_price.o_sheets, v_price.o_rate, v_price.o_total, left(nullif(btrim(p_student_note), ''), 500),
    p_payment_method, v_date,
    case when p_payment_method = 'PAY_AT_COUNTER'
         then private.next_order_number(p_shop_id, v_date) end,
    v_price.o_unit
  ) returning * into v_order;

  -- sort_order = the student's order of the files; the array position, nothing else.
  insert into public.order_files (order_id, sort_order, storage_path, original_name, mime_type, size_bytes, page_count)
  select v_order.id, (e.ord - 1)::int, e.f ->> 'storage_path',
         coalesce(nullif(left(regexp_replace(coalesce(e.f ->> 'original_name', ''), '[\x00-\x1f\x7f/\\]', '_', 'g'), 255), ''), 'document'),
         e.f ->> 'mime_type', (e.f ->> 'size_bytes')::bigint, (e.f ->> 'page_count')::int
    from jsonb_array_elements(p_files) with ordinality as e (f, ord);

  return v_order;
end $$;

-- 6. Paying and cancelling --------------------------------------------------------
create or replace function public.attach_payment_order(
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
  if v_order.payment_method <> 'ONLINE'
     or v_order.payment_status not in ('PENDING', 'FAILED')
     or not ((v_order.accept_first and v_order.status = 'ACCEPTED')
          or (not v_order.accept_first and v_order.status = 'PENDING')) then
    raise exception 'Order cannot be paid' using errcode = 'P0001';
  end if;
  if v_order.payment_order_id is not null then
    return v_order;
  end if;
  update public.orders set payment_order_id = p_payment_order_id
   where id = p_order_id returning * into v_order;
  return v_order;
end $$;

-- A student may cancel an online order until printing starts. Unpaid: it just
-- closes. Paid: orders_lifecycle moves it to REFUND_PENDING, the existing manual
-- refund workflow (nothing is refunded automatically). PRINTING and later: refused.
-- Counter orders keep today's rule: PENDING only.
create or replace function public.cancel_order(p_order_id uuid) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_order public.orders;
  v_paid  boolean;
  v_label text;
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
  if not (v_order.status = 'PENDING'
          or (v_order.status = 'ACCEPTED' and v_order.payment_method = 'ONLINE')) then
    raise exception 'This order can no longer be cancelled' using errcode = 'P0001';
  end if;
  v_paid  := v_order.payment_status = 'PAID';
  v_label := coalesce(v_order.order_number, upper(left(v_order.id::text, 8)));

  update public.orders
     set status = 'CANCELLED', status_reason = 'Cancelled by student'
   where id = p_order_id
   returning * into v_order;

  -- The shop may be about to print it, and a paid one needs settling.
  if v_order.payment_method = 'ONLINE' and (v_order.accept_first or v_paid) then
    insert into public.notifications (user_id, order_id, type, title, body)
    select p.id, v_order.id, 'order_cancelled_by_student', 'Order ' || v_label || ' was cancelled by the student',
           case when v_paid
                then 'Do not print it. The payment is recorded and nothing is refunded automatically: settle it under Paid, not completed.'
                else 'Do not print it.' end
      from public.profiles p
     where p.shop_id = v_order.shop_id and p.role = 'shopkeeper' and p.deleted_at is null;
  end if;

  return v_order;
end $$;

-- Idempotent: a second run finds nothing left to cancel. Only unpaid rows match,
-- and a payment committing first makes the row stop matching, so a confirmed paid
-- order is never expired. A capture arriving after expiry takes the existing
-- paid_after_cancel path (REFUND_PENDING, both sides told).
create or replace function private.cancel_stale_unpaid_orders() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  with cancelled as (
    update public.orders
       set status = 'CANCELLED',
           status_reason = case
             when status = 'ACCEPTED' then 'Not paid within 24 hours of being accepted'
             when payment_method = 'PAY_AT_COUNTER' or accept_first then 'Not accepted by the shop within 24 hours'
             else 'Not paid within 24 hours' end
     where payment_status in ('PENDING', 'FAILED')
       and ((status = 'PENDING' and created_at < now() - interval '24 hours')
         or (status = 'ACCEPTED' and accept_first and payment_method = 'ONLINE'
             and accepted_at < now() - interval '24 hours'))
    returning 1
  )
  select count(*) into v_count from cancelled;
  return v_count;
end $$;

-- 7. Printing: hand-over is recorded, then a person confirms ----------------------
-- Called by POST /api/shop/orders/[id]/print once the shopkeeper is authorised and
-- before signed URLs go out. Records that the document was handed to the browser;
-- it does NOT start printing. Returns the previous hand-over time, so a second tab
-- can warn before opening a second dialog.
create function public.request_print(p_order_id uuid, p_shop_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
  v_prev  timestamptz;
begin
  select * into v_order from public.orders
   where id = p_order_id and shop_id = p_shop_id for update;
  if not found
     or not (v_order.payment_status = 'PAID' or v_order.payment_method = 'PAY_AT_COUNTER')
     or not (v_order.status in ('ACCEPTED', 'PRINTING', 'READY')
             or (v_order.status = 'PENDING' and v_order.payment_method = 'ONLINE' and not v_order.accept_first)) then
    raise exception 'This order cannot be printed' using errcode = 'P0001';
  end if;
  v_prev := v_order.print_requested_at;
  update public.orders set print_requested_at = now() where id = p_order_id;
  return v_prev;
end $$;

-- The shopkeeper's "Printing started". A compare-and-set: true only for the call
-- that started printing, false for a repeat, a closed order or no prior hand-over.
-- orders_lifecycle still refuses an unpaid online order.
create function public.confirm_printing(p_order_id uuid, p_shop_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.orders
     set status = 'PRINTING'
   where id = p_order_id
     and shop_id = p_shop_id
     and print_requested_at is not null
     and (status = 'ACCEPTED' or (status = 'PENDING' and payment_method = 'ONLINE' and not accept_first));
  return found;
end $$;

revoke all on function public.request_print(uuid, uuid) from public, anon, authenticated;
revoke all on function public.confirm_printing(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_print(uuid, uuid) to service_role;
grant execute on function public.confirm_printing(uuid, uuid) to service_role;

commit;
