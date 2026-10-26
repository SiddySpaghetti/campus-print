-- =============================================================================
-- CampusPrint — late payments and refund amounts (manual refunds only)
-- =============================================================================
-- Nothing here moves money. It changes how verified Razorpay events are
-- RECORDED so the database never claims more than Razorpay confirmed:
--
-- 1. orders.refunded_paise: the sum of Razorpay-confirmed refunds. An order
--    becomes REFUNDED only when a verified refund.processed brings this to the
--    full total. A partial refund keeps REFUND_PENDING ("Paid · not
--    completed") and tells the student how much is still outstanding.
-- 2. Refund events must carry the Razorpay refund id (payload.refund_id); the
--    same refund is counted once even if it arrives under another event id
--    (webhook retry vs. manual reconciliation). A refund larger than what is
--    left, without an id, in another currency, or for an order that isn't
--    paid is recorded and left for manual reconciliation (never applied).
-- 3. refund.failed is recorded (nothing changes) so it can be found.
-- 4. A refund confirmed on an order that is still PAID (live or collected) is
--    recorded in refunded_paise; the order stays PAID.
-- 5. A capture on an already cancelled/rejected order still lands as
--    REFUND_PENDING (orders_lifecycle) and now notifies the student and shop;
--    process_payment_event answers 'paid_after_cancel' for the logs.
-- 6. payment_events.result keeps each event's outcome (audit trail).
--
-- Safe with the old app (its refund events carry no refund_id: recorded, not
-- applied, until the new webhook parser is deployed). Needs 20261025120000;
-- independent of 20261025120100, whose guard then also keeps admin/API
-- sessions off refunded_paise (shopkeepers are already kept off it).
-- =============================================================================

begin;

alter table public.orders
  add column refunded_paise int not null default 0
  check (refunded_paise >= 0 and refunded_paise <= total_paise);

-- Orders already REFUNDED were refunded in full (that was the only kind).
update public.orders set refunded_paise = total_paise where payment_status = 'REFUNDED';

alter table public.payment_events add column result text;

create or replace function public.process_payment_event(
  p_provider text, p_event_id text, p_event_type text,
  p_payment_order_id text, p_payment_id text,
  p_amount_paise int, p_currency text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_order     public.orders;
  v_result    text;
  v_inserted  int;
  v_refund_id text := p_payload ->> 'refund_id';
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
      -- orders_lifecycle turns a capture on a cancelled/rejected order into REFUND_PENDING.
      v_result := case when v_order.status in ('CANCELLED', 'REJECTED') then 'paid_after_cancel' else 'paid' end;
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
  elsif p_event_type = 'refund.processed' then
    if v_refund_id is null or v_refund_id !~ '^rfnd_[A-Za-z0-9]{6,40}$' then
      v_result := 'refund_unverified';
    elsif p_currency is distinct from 'INR' or p_amount_paise is null or p_amount_paise <= 0 then
      v_result := 'refund_amount_invalid';
    elsif exists (select 1 from public.payment_events e
                   where e.provider = p_provider and e.event_id <> p_event_id
                     and e.payload ->> 'refund_id' = v_refund_id
                     and e.result in ('refunded', 'partially_refunded', 'refund_on_paid_order')) then
      v_result := 'duplicate_refund';
    elsif v_order.payment_status not in ('PAID', 'REFUND_PENDING') then
      v_result := 'ignored_state';
    elsif v_order.refunded_paise + p_amount_paise > v_order.total_paise then
      v_result := 'refund_exceeds_total';
    else
      update public.orders
         set refunded_paise = refunded_paise + p_amount_paise,
             refund_id      = v_refund_id,
             payment_status = case when payment_status = 'REFUND_PENDING'
                                    and refunded_paise + p_amount_paise = total_paise
                                   then 'REFUNDED'::public.payment_status else payment_status end
       where id = v_order.id;
      v_result := case
        when v_order.payment_status = 'PAID' then 'refund_on_paid_order'
        when v_order.refunded_paise + p_amount_paise = v_order.total_paise then 'refunded'
        else 'partially_refunded' end;
    end if;
  elsif p_event_type = 'refund.failed' then
    v_result := 'refund_failed';
  else
    v_result := 'ignored';
  end if;

  update public.payment_events set processed_at = now(), result = v_result
   where provider = p_provider and event_id = p_event_id;
  return v_result;
end $$;

-- Late-payment and partial-refund notices (otherwise identical to the version
-- in 20261025120000_print_on_download.sql).
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

  -- A Razorpay-confirmed refund for LESS than the order total.
  if new.refunded_paise > old.refunded_paise and new.payment_status <> 'REFUNDED' then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_partial', 'Partial refund for ' || lower(v_label),
            'Razorpay confirmed a refund of ₹' || to_char((new.refunded_paise - old.refunded_paise) / 100.0, 'FM999999990.00')
            || '. ₹' || to_char((new.total_paise - new.refunded_paise) / 100.0, 'FM999999990.00')
            || ' of your payment has not been refunded; to request it, contact the shop.');
  end if;

  if new.payment_status = 'REFUNDED' and old.payment_status is distinct from 'REFUNDED' then
    insert into public.notifications (user_id, order_id, type, title, body)
    values (new.student_id, new.id, 'refund_issued', 'Refund issued for ' || lower(v_label),
            'Your money is on its way back to you.');
  end if;

  return null;
end $$;

commit;
