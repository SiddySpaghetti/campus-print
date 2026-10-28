-- =============================================================================
-- CampusPrint — notices when a PAY_AT_COUNTER order is placed
-- =============================================================================
-- Online orders notify the student and the shop when payment is verified
-- (orders_notify, AFTER UPDATE). Counter orders are never paid in the system,
-- so until now nobody was told one had been placed. This sends both notices in
-- the same transaction as the INSERT:
--   student:     order_placed  "Order X placed" (pay at the counter)
--   shopkeeper:  new_order     "New order X"    (accept it to start)
-- Counter orders only (the WHEN clause): an unpaid online order gets nothing
-- here, and its "confirmed" notice still comes only from a verified payment.
-- Once per order: orders are only ever inserted by create_order_verified
-- (orders_insert_guard), whose retry path returns the existing order without
-- inserting, and a counter order can never become PAID (attach_payment_order
-- refuses it), so orders_notify's payment branch never repeats these.
-- =============================================================================

begin;

create function private.orders_notify_created() returns trigger
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

revoke execute on function private.orders_notify_created() from public, anon, authenticated;

create trigger orders_90_notify_created after insert on public.orders
  for each row when (new.payment_method = 'PAY_AT_COUNTER')
  execute function private.orders_notify_created();

commit;
