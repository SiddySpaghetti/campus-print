-- =============================================================================
-- CampusPrint — paid online orders go straight to printing (no Accept step)
-- =============================================================================
-- Step 1 of 2. Safe to apply BEFORE the app deploy: it only allows one more move.
--
--   ONLINE:          PENDING (paid) -> PRINTING -> READY -> COMPLETED
--   PAY_AT_COUNTER:  PENDING -> ACCEPTED -> PRINTING -> READY -> COMPLETED (unchanged)
--
-- PENDING -> PRINTING is allowed only for ONLINE orders, and the existing check
-- below still refuses it unless payment_status = 'PAID' (set only by the
-- verified process_payment_event). Counter orders must still be accepted.
-- Reject (PENDING) and cancel (ACCEPTED/PRINTING) of a PAID order still move it
-- to REFUND_PENDING here, in the same transaction as the status change.
-- Adds public.start_printing (service role only) for the download route. Who
-- may make the PRINTING move is restricted in step 2
-- (20261025120100_printing_only_via_download.sql).
-- Otherwise identical to the versions it replaces (pay_at_counter.sql, init).
-- =============================================================================

begin;

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

-- The one way into PRINTING (step 2 makes orders_guard refuse it from every API
-- role). Called by POST /api/shop/files/[id] with the service role, only after
-- it has authorised the shopkeeper, matched the shop and signed the download.
-- A compare-and-set: true if this call started printing, false if the order
-- was not (any longer) waiting to print, e.g. a re-download or a second tab.
-- orders_lifecycle still refuses an unpaid ONLINE order.
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

-- The student's "confirmed" notice no longer promises an Accept step, and a
-- cancelled/rejected PAID order's notice promises no refund: it directs the
-- student to the shop. ("Refund issued" is still sent, but only when Razorpay's
-- verified refund.processed event marks the order REFUNDED.)
create or replace function private.orders_notify() returns trigger
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
            v_label || ' confirmed', 'Payment received. The shop will print it soon.');

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
      values (new.student_id, new.id, v_type, v_title,
              -- A paid order that won't be completed: no refund is promised or
              -- issued automatically (pilot policy); send the student to the shop.
              case when new.status in ('CANCELLED', 'REJECTED') and new.payment_status = 'REFUND_PENDING'
                   then concat_ws(' ', new.status_reason, 'Your payment is recorded and has not been refunded. To request a refund, contact the shop.')
                   else new.status_reason end);
    end if;
  end if;

  if new.payment_status = 'REFUNDED' and old.payment_status is distinct from 'REFUNDED' then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_issued', 'Refund issued for ' || lower(v_label),
            'Your money is on its way back to you.');
  end if;

  return null;
end $$;

commit;
