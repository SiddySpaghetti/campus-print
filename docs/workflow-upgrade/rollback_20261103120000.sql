-- ROLLBACK of 20261103120000_accept_first_and_print_request. Manual, SQL editor.
-- Then: supabase migration repair --status reverted 20261103120000
-- Refuses while any accept_first order exists: the old app and old policies cannot
-- serve them. Roll back step 2 first and let them finish or expire.
begin;

do $$
begin
  if exists (select 1 from public.orders where accept_first) then
    raise exception 'Refusing to roll back: accept_first orders exist';
  end if;
  if exists (select 1 from public.order_files where sort_order > 0) then
    raise notice 'Multi-file orders exist: their stored file order is lost by this rollback';
  end if;
end $$;

drop function public.request_print(uuid, uuid);
drop function public.confirm_printing(uuid, uuid);
drop function public.quote_order(uuid, text, text, text, int, int[]);

drop policy orders_select_shop on public.orders;
create policy orders_select_shop on public.orders for select to authenticated
  using (shop_id = private.my_shop_id()
         and (paid_at is not null or payment_method = 'PAY_AT_COUNTER'));
drop policy orders_update_shop on public.orders;
create policy orders_update_shop on public.orders for update to authenticated
  using (shop_id = private.my_shop_id()
         and (paid_at is not null or payment_method = 'PAY_AT_COUNTER'))
  with check (shop_id = private.my_shop_id()
         and (paid_at is not null or payment_method = 'PAY_AT_COUNTER'));
drop policy order_files_select_shop on public.order_files;
create policy order_files_select_shop on public.order_files for select to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_files.order_id
                    and o.shop_id = private.my_shop_id()
                    and (o.paid_at is not null or o.payment_method = 'PAY_AT_COUNTER')));

drop trigger orders_90_notify_created on public.orders;
create trigger orders_90_notify_created after insert on public.orders
  for each row when (new.payment_method = 'PAY_AT_COUNTER')
  execute function private.orders_notify_created();

-- Restored verbatim from the repo's earlier migrations:
create or replace function private.orders_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
begin
  if new.payment_method is distinct from old.payment_method then
    raise exception 'The payment method cannot change' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'PENDING'  and new.status in ('ACCEPTED', 'REJECTED', 'CANCELLED'))
      -- Paid online orders skip Accept: the shop's download starts printing.
      or (old.status = 'PENDING'  and new.status = 'PRINTING' and new.payment_method = 'ONLINE')
      or (old.status = 'ACCEPTED' and new.status in ('PRINTING', 'CANCELLED'))
      or (old.status = 'PRINTING' and new.status in ('READY', 'CANCELLED'))
      or (old.status = 'READY'    and new.status = 'COMPLETED')
    ) then
      raise exception 'Invalid order status change: % -> %', old.status, new.status
        using errcode = '23514';
    end if;

    -- Online orders are worked only after the money has arrived. Counter
    -- orders are paid in person at pickup and stay unpaid in the system.
    if new.status in ('ACCEPTED', 'PRINTING', 'READY', 'COMPLETED')
       and new.payment_status <> 'PAID'
       and new.payment_method <> 'PAY_AT_COUNTER' then
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

create or replace function private.orders_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_label text := coalesce('Order ' || new.order_number, 'Your order');
  v_type  text;
  v_title text;
  v_total text := '₹' || to_char(new.total_paise / 100.0, 'FM999999990.00');
begin
  -- Payment just succeeded on a live order: confirm to the student, alert the shop.
  if new.paid_at is not null and old.paid_at is null and new.status = 'PENDING' then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'order_placed',
            v_label || ' confirmed', 'Payment received. The shop will print it soon.');

    insert into public.notifications (user_id, order_id, type, title, body)
    select p.id, new.id, 'new_order', 'New order ' || new.order_number, 'A new paid order is waiting.'
      from public.profiles p
     where p.shop_id = new.shop_id and p.role = 'shopkeeper' and p.deleted_at is null;
  end if;

  -- Captured AFTER the order was cancelled/rejected (e.g. a checkout left open
  -- past the 24h auto-cancel). orders_lifecycle records it as REFUND_PENDING;
  -- nothing was printed and nothing is refunded automatically. Tell both sides.
  if new.paid_at is not null and old.paid_at is null and new.status in ('CANCELLED', 'REJECTED') then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'payment_after_cancel', v_label || ' was paid after it was cancelled',
            'Your payment of ' || v_total || ' is recorded and has not been refunded. To request a refund, contact the shop.');

    insert into public.notifications (user_id, order_id, type, title, body)
    select p.id, new.id, 'payment_after_cancel', 'Payment received for cancelled order ' || new.order_number,
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
              -- A paid order that won't be completed: no refund is promised or
              -- issued automatically (pilot policy); send the student to the shop.
              case when new.status in ('CANCELLED', 'REJECTED') and new.payment_status = 'REFUND_PENDING'
                   then concat_ws(' ', new.status_reason, 'Your payment is recorded and has not been refunded. To request a refund, contact the shop.')
                   else new.status_reason end);
    end if;
  end if;

  -- A Razorpay-confirmed refund that still leaves part of the total unrefunded.
  if new.refunded_paise > old.refunded_paise and new.refunded_paise < new.total_paise then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_partial', 'Partial refund for ' || lower(v_label),
            'Razorpay confirmed a refund of ₹' || to_char((new.refunded_paise - old.refunded_paise) / 100.0, 'FM999999990.00')
            || '. ₹' || to_char((new.total_paise - new.refunded_paise) / 100.0, 'FM999999990.00')
            || ' of your payment has not been refunded; to request it, contact the shop.');
  end if;

  -- Fully refunded: marked REFUNDED (a cancelled/rejected order), or a live/collected
  -- order whose confirmed refunds now cover the total (it stays PAID).
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
  v_label text := coalesce('Order ' || new.order_number, 'Your order');
begin
  insert into public.notifications (user_id, order_id, type, title, body)
  values (new.student_id, new.id, 'order_placed', v_label || ' placed',
          'Pay at the counter when you collect it. You''ll hear here when the shop accepts it.');

  insert into public.notifications (user_id, order_id, type, title, body)
  select p.id, new.id, 'new_order', 'New order ' || coalesce(new.order_number, ''),
         'Pay at the counter. Accept it to start printing.'
    from public.profiles p
   where p.shop_id = new.shop_id and p.role = 'shopkeeper' and p.deleted_at is null;

  return null;
end $$;

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
     or v_order.status <> 'PENDING' or v_order.payment_status not in ('PENDING', 'FAILED') then
    raise exception 'Order cannot be paid' using errcode = 'P0001';
  end if;
  if v_order.payment_order_id is not null then
    return v_order;
  end if;
  update public.orders set payment_order_id = p_payment_order_id
   where id = p_order_id returning * into v_order;
  return v_order;
end $$;

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

create or replace function private.cancel_stale_unpaid_orders() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  with cancelled as (
    update public.orders
       set status = 'CANCELLED',
           status_reason = case when payment_method = 'PAY_AT_COUNTER'
                                then 'Not accepted by the shop within 24 hours'
                                else 'Not paid within 24 hours' end
     where status = 'PENDING'
       and payment_status in ('PENDING', 'FAILED')
       and created_at < now() - interval '24 hours'
    returning 1
  )
  select count(*) into v_count from cancelled;
  return v_count;
end $$;

drop function private.price_order(uuid, text, text, text, int, int[]);

create index order_files_order_idx on public.order_files (order_id);
drop index public.order_files_order_sort_key;
alter table public.order_files drop column sort_order;
alter table public.orders drop constraint orders_work_requires_payment;
alter table public.orders drop column print_requested_at, drop column accept_first, drop column paid_after_cancel;

commit;
