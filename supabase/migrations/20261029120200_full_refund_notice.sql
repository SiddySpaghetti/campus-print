-- =============================================================================
-- CampusPrint — a full refund on a live order is told as a full refund
-- =============================================================================
-- Before: a Razorpay-confirmed refund that brought a PAID (live or collected)
-- order's refunded_paise up to its total sent "Partial refund … ₹0.00 of your
-- payment has not been refunded", because such an order stays PAID (it is
-- never marked REFUNDED; process_payment_event, unchanged). Now a refund that
-- covers the total sends the usual "Refund issued" notice instead; a partial
-- one still says what is outstanding. Notices only: no refund calculation,
-- payment state or amount changes. Otherwise identical to orders_notify in
-- 20261025120200_payment_reconciliation.sql. Independent of the unapplied
-- 20261029120100 (it adds a separate INSERT trigger, not this function).
-- =============================================================================

begin;

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

commit;
