-- =============================================================================
-- CampusPrint — repeatable database security checks
-- =============================================================================
-- HOW TO RUN: paste PART A, then PART B, into the Supabase SQL editor (or the MCP
-- execute_sql tool), one DO block at a time. Each block ENDS WITH AN EXCEPTION on
-- purpose: that rolls back every fixture, so nothing is persisted. The exception
-- text is the report: every line is "PASS ..." or "FAIL ...".
--
-- Why fixtures: "0 rows" from an empty table proves nothing. Each block inserts a
-- second student, extra shops, paid/unpaid orders, files, storage objects,
-- notifications and payment events (all rolled back), asserts they exist, and
-- only then checks who can see or change them.
--
-- Real accounts (by auth id) are impersonated with SET LOCAL ROLE + a JWT `sub`
-- claim, the way PostgREST does it:
--   student     b0525bd1-1533-414a-9463-c6cd16bf5d8e
--   shopkeeper  37ee3d16-d5a7-4105-88f3-8485579ca862  (shop abc-xerox)
--   admin       21841d3f-08a6-4fae-881e-7e1b816d69ed
-- Not covered here (see tests/server-security.test.ts and the report): real
-- logins over HTTP, the Storage HTTP API, signed URLs, concurrency under load.
-- =============================================================================


-- ===================================== PART A: RLS / roles / storage ==========
do $$
declare
  stu   uuid := 'b0525bd1-1533-414a-9463-c6cd16bf5d8e';
  shk   uuid := '37ee3d16-d5a7-4105-88f3-8485579ca862';
  adm   uuid := '21841d3f-08a6-4fae-881e-7e1b816d69ed';
  stu2  uuid := '00000000-0000-4000-8000-0000000000a2';
  shk2  uuid := '00000000-0000-4000-8000-0000000000b2';
  sh1   uuid; sh2 uuid := gen_random_uuid(); sh3 uuid := gen_random_uuid();
  o1 uuid; o1u uuid; o2 uuid; o3 uuid;
  n int; r text := '';
begin
  select id into sh1 from public.shops where slug = 'abc-xerox';
  if sh1 is null then raise exception 'ABORT: shop abc-xerox missing'; end if;

  insert into auth.users (id, email, aud, role) values
    (stu2, 'fixture-student2@example.invalid', 'authenticated', 'authenticated'),
    (shk2, 'fixture-shopkeeper2@example.invalid', 'authenticated', 'authenticated');
  insert into public.shops (id, name, slug, order_prefix, is_verified, is_open) values
    (sh2, 'Fixture Shop 2', 'fixture-2', 'Y', true, false),
    (sh3, 'Fixture Shop 3', 'fixture-3', 'Z', false, true);
  update public.profiles set role = 'shopkeeper', shop_id = sh2 where id = shk2;
  insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise)
    values (sh2, 'print', 'bw', 'a4', 100), (sh3, 'print', 'bw', 'a4', 100);

  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
  values (stu,  sh1, 'bw','a4','single',1,1,1,200,200) returning id into o1;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
  values (stu,  sh1, 'bw','a4','single',1,1,1,200,200) returning id into o1u;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
  values (stu2, sh2, 'bw','a4','single',1,1,1,100,100) returning id into o2;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
  values (stu2, sh1, 'bw','a4','single',1,1,1,200,200) returning id into o3;
  update public.orders set payment_status = 'PAID' where id in (o1, o2, o3);

  insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count) values
    (o1,  stu::text  || '/up1/a.pdf', 'a.pdf', 'application/pdf', 10, 1),
    (o1u, stu::text  || '/up3/c.pdf', 'c.pdf', 'application/pdf', 10, 1),
    (o2,  stu2::text || '/up2/b.pdf', 'b.pdf', 'application/pdf', 10, 1),
    (o3,  stu2::text || '/up4/d.pdf', 'd.pdf', 'application/pdf', 10, 1);
  insert into storage.objects (bucket_id, name) values
    ('print-files', stu::text  || '/up1/a.pdf'), ('print-files', stu::text  || '/up3/c.pdf'),
    ('print-files', stu2::text || '/up2/b.pdf'), ('print-files', stu2::text || '/up4/d.pdf'),
    ('print-files', stu::text  || '/up9/new.pdf');
  insert into public.payment_events (provider, event_id, event_type, order_id, payload)
    values ('razorpay', 'evt_fixture_1', 'payment.captured', o2, '{}');

  select count(*) into n from public.notifications where user_id = stu2;
  r := r || case when n > 0 then 'PASS fixture: other student has notifications' else 'FAIL fixture: no notifications' end;
  select count(*) into n from public.order_counters;
  r := r || case when n > 0 then 'PASS fixture: order_counters non-empty' else 'FAIL fixture: order_counters empty' end;
  select count(*) into n from public.payment_events;
  r := r || case when n > 0 then 'PASS fixture: payment_events non-empty' else 'FAIL fixture: payment_events empty' end;

  -- role / shop invariants (as the trusted owner)
  begin update public.profiles set role = 'admin', shop_id = sh1 where id = stu; r := r || 'FAIL invariant: student/admin linked to a shop'; exception when check_violation then r := r || 'PASS invariant: a non-shopkeeper cannot have a shop_id'; end;
  begin update public.profiles set role = 'shopkeeper' where id = stu;           r := r || 'FAIL invariant: shopkeeper without shop'; exception when check_violation then r := r || 'PASS invariant: a shopkeeper must have a shop'; end;
  begin update public.profiles set role = 'admin' where id = shk;                r := r || 'FAIL invariant: admin keeps a shop_id'; exception when check_violation then r := r || 'PASS invariant: promoting a shopkeeper to admin without clearing shop_id is rejected'; end;
  begin update public.profiles set role = 'shopkeeper', shop_id = sh1 where id = shk2; r := r || 'FAIL invariant: two shopkeepers on one shop'; exception when unique_violation then r := r || 'PASS invariant: one shopkeeper account per shop'; end;

  -- ANON
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform 1 from public.profiles;       r := r || 'FAIL anon: read profiles'; exception when insufficient_privilege then r := r || 'PASS anon: profiles denied'; end;
  begin perform 1 from public.orders;         r := r || 'FAIL anon: read orders';   exception when insufficient_privilege then r := r || 'PASS anon: orders denied'; end;
  begin perform 1 from public.order_files;    r := r || 'FAIL anon: read order_files'; exception when insufficient_privilege then r := r || 'PASS anon: order_files denied'; end;
  begin perform 1 from public.notifications;  r := r || 'FAIL anon: read notifications'; exception when insufficient_privilege then r := r || 'PASS anon: notifications denied'; end;
  begin perform 1 from public.payment_events; r := r || 'FAIL anon: read payment_events'; exception when insufficient_privilege then r := r || 'PASS anon: payment data denied'; end;
  begin perform 1 from public.shops;          r := r || 'FAIL anon: read shops';    exception when insufficient_privilege then r := r || 'PASS anon: shops table denied'; end;
  begin perform 1 from public.shop_pricing;   r := r || 'FAIL anon: read pricing';  exception when insufficient_privilege then r := r || 'PASS anon: shop_pricing denied'; end;
  select count(*) into n from public.public_shops;
  r := r || case when n >= 1 then 'PASS anon: public_shops readable (intentional)' else 'FAIL anon: public_shops empty' end;
  select count(*) into n from public.public_shops where slug in ('fixture-2','fixture-3');
  r := r || case when n = 1 then 'PASS anon: public_shops hides unverified shop, lists verified' else 'FAIL anon: public_shops listing wrong n=' || n end;
  select count(*) into n from storage.objects where bucket_id = 'print-files';
  r := r || case when n = 0 then 'PASS anon: private storage objects invisible (5 exist)' else 'FAIL anon: sees storage objects n=' || n end;
  begin insert into storage.objects (bucket_id, name) values ('print-files', 'anon/x.pdf'); r := r || 'FAIL anon: storage insert'; exception when others then r := r || 'PASS anon: storage insert denied'; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1,'[]'); r := r || 'FAIL anon: create_order_verified callable'; exception when insufficient_privilege then r := r || 'PASS anon: cannot create orders'; end;
  begin perform public.cancel_order(o1);   r := r || 'FAIL anon: cancel_order callable'; exception when insufficient_privilege then r := r || 'PASS anon: cancel_order denied'; end;
  begin perform public.process_payment_event('razorpay','e','payment.captured','order_x','pay_x',1,'INR','{}'); r := r || 'FAIL anon: process_payment_event'; exception when insufficient_privilege then r := r || 'PASS anon: cannot post payment events'; end;
  begin perform private.is_admin();        r := r || 'FAIL anon: private.is_admin callable'; exception when insufficient_privilege then r := r || 'PASS anon: private helpers denied'; end;

  -- STUDENT (real account)
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', stu, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin update public.profiles set role = 'admin' where id = stu;  r := r || 'FAIL student: set own role=admin'; exception when others then r := r || 'PASS student: cannot set own role (' || sqlstate || ')'; end;
  begin update public.profiles set role = 'shopkeeper', shop_id = sh1 where id = stu; r := r || 'FAIL student: became shopkeeper'; exception when others then r := r || 'PASS student: cannot become shopkeeper'; end;
  begin update public.profiles set shop_id = sh1 where id = stu;   r := r || 'FAIL student: set own shop_id'; exception when others then r := r || 'PASS student: cannot set own shop_id'; end;
  begin update public.profiles set id = stu2 where id = stu;       r := r || 'FAIL student: changed own id'; exception when others then r := r || 'PASS student: cannot change own id'; end;
  begin insert into public.profiles (id, role) values (gen_random_uuid(), 'admin'); r := r || 'FAIL student: inserted an admin profile'; exception when others then r := r || 'PASS student: cannot create another admin'; end;
  update public.profiles set full_name = 'Test Name' where id = stu; get diagnostics n = row_count;
  r := r || case when n = 1 then 'PASS student: can edit own name' else 'FAIL student: cannot edit own name' end;
  update public.profiles set full_name = 'Hacked' where id = stu2;   get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS student: cannot edit another profile' else 'FAIL student: edited another profile' end;
  select count(*) into n from public.profiles where id <> stu;
  r := r || case when n = 0 then 'PASS student: sees no other profile (3+ exist)' else 'FAIL student: sees other profiles n=' || n end;

  select count(*) into n from public.orders where id in (o2, o3);
  r := r || case when n = 0 then 'PASS student: cannot read another student''s orders' else 'FAIL student: read other orders n=' || n end;
  select count(*) into n from public.orders where id in (o1, o1u);
  r := r || case when n = 2 then 'PASS student: reads own orders (paid + unpaid)' else 'FAIL student: own orders n=' || n end;
  select count(*) into n from public.order_files where order_id in (o2, o3);
  r := r || case when n = 0 then 'PASS student: cannot read another student''s order_files' else 'FAIL student: read other files rows' end;
  select count(*) into n from public.order_files where order_id in (o1, o1u);
  r := r || case when n = 2 then 'PASS student: reads own order_files' else 'FAIL student: own order_files n=' || n end;
  select count(*) into n from storage.objects where name = stu2::text || '/up2/b.pdf';
  r := r || case when n = 0 then 'PASS student: other student''s file unreadable even with the exact path' else 'FAIL student: read other student''s object' end;
  select count(*) into n from storage.objects where bucket_id = 'print-files';
  r := r || case when n = 3 then 'PASS student: reads only own 3 storage objects' else 'FAIL student: storage objects n=' || n end;
  begin insert into storage.objects (bucket_id, name) values ('print-files', stu2::text || '/evil.pdf'); r := r || 'FAIL student: uploaded into another user''s folder'; exception when others then r := r || 'PASS student: cannot upload into another user''s folder'; end;
  begin insert into storage.objects (bucket_id, name) values ('print-files', 'loose.pdf');                 r := r || 'FAIL student: uploaded to bucket root'; exception when others then r := r || 'PASS student: cannot upload to the bucket root'; end;
  begin insert into storage.objects (bucket_id, name) values ('print-files', stu::text || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf'); r := r || 'FAIL student: direct upload to own folder (must use signed URL)'; exception when others then r := r || 'PASS student: no direct uploads at all (server-issued signed URLs only)'; end;
  begin insert into storage.objects (bucket_id, name) values ('print-files', stu::text || '/up1/a.pdf'); r := r || 'FAIL student: re-uploaded over an existing file'; exception when others then r := r || 'PASS student: cannot overwrite an existing file'; end;
  update storage.objects set name = stu::text || '/up1/renamed.pdf' where name = stu::text || '/up1/a.pdf'; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS student: cannot modify stored files' else 'FAIL student: modified storage object' end;
  begin
    delete from storage.objects where name = stu::text || '/up1/a.pdf'; get diagnostics n = row_count;
    r := r || case when n = 0 then 'PASS student: cannot delete stored files' else 'FAIL student: deleted storage object' end;
  exception when others then r := r || 'PASS student: cannot delete stored files (' || sqlstate || ')'; end;
  select count(*) into n from public.notifications where user_id = stu2;
  r := r || case when n = 0 then 'PASS student: cannot read another user''s notifications' else 'FAIL student: read others notifications' end;
  begin update public.notifications set title = 'x' where user_id = stu; r := r || 'FAIL student: edited notification text'; exception when others then r := r || 'PASS student: notification text immutable'; end;
  update public.notifications set read_at = now() where user_id = stu2; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS student: cannot touch another user''s notifications' else 'FAIL student: modified other notifications' end;
  begin insert into public.notifications (user_id, type, title) values (stu, 'order_ready', 'forged'); r := r || 'FAIL student: forged a notification'; exception when others then r := r || 'PASS student: cannot forge notifications'; end;
  begin insert into public.notifications (user_id, type, title) values (stu2, 'order_ready', 'forged'); r := r || 'FAIL student: forged a notification for someone else'; exception when others then r := r || 'PASS student: cannot forge notifications for others'; end;

  select count(*) into n from public.shops;          r := r || case when n = 0 then 'PASS student: shops table (phone etc.) hidden' else 'FAIL student: reads shops table' end;
  select count(*) into n from public.payment_events; r := r || case when n = 0 then 'PASS student: payment_events hidden (rows exist)' else 'FAIL student: reads payment_events' end;
  begin insert into public.payment_events (provider, event_id, event_type, payload) values ('razorpay','forged','payment.captured','{}'); r := r || 'FAIL student: forged payment event'; exception when others then r := r || 'PASS student: cannot write payment_events'; end;
  begin update public.payment_events set event_type = 'x'; r := r || 'FAIL student: updated payment_events'; exception when others then r := r || 'PASS student: cannot modify payment_events'; end;
  begin delete from public.payment_events;                 r := r || 'FAIL student: deleted payment_events'; exception when others then r := r || 'PASS student: cannot delete payment_events'; end;
  select count(*) into n from public.order_counters; r := r || case when n = 0 then 'PASS student: order_counters hidden (rows exist)' else 'FAIL student: reads order_counters' end;
  update public.order_counters set last_number = 0; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS student: cannot reset order counters' else 'FAIL student: changed order_counters' end;
  begin insert into public.order_counters (shop_id, order_date, last_number) values (sh1, current_date, 0); r := r || 'FAIL student: inserted counter'; exception when others then r := r || 'PASS student: cannot insert order counters'; end;
  select count(*) into n from public.shop_pricing where shop_id = sh3;
  r := r || case when n = 0 then 'PASS student: pricing of unlisted shop hidden' else 'FAIL student: reads unlisted pricing' end;
  begin insert into public.shops (name, slug, order_prefix) values ('x','x','Q');                          r := r || 'FAIL student: inserted shop';    exception when others then r := r || 'PASS student: cannot insert shop'; end;
  update public.shops set is_open = true where id = sh1; get diagnostics n = row_count;                    r := r || case when n = 0 then 'PASS student: cannot update shop' else 'FAIL student: updated shop' end;
  update public.shop_pricing set price_paise = 1 where shop_id = sh1; get diagnostics n = row_count;       r := r || case when n = 0 then 'PASS student: cannot change prices' else 'FAIL student: changed prices' end;
  begin insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise) values (sh1,'print','bw','a4',1); r := r || 'FAIL student: inserted pricing'; exception when others then r := r || 'PASS student: cannot insert pricing'; end;
  begin insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise, payment_status, status)
        values (stu, sh1,'bw','a4','single',1,1,1,1,1,'PAID','ACCEPTED');                                  r := r || 'FAIL student: direct order insert'; exception when others then r := r || 'PASS student: direct INSERT into orders blocked'; end;
  update public.orders set payment_status = 'PAID', total_paise = 1, rate_per_sheet_paise = 1 where id = o1u; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS student: cannot mark own order paid / change price' else 'FAIL student: updated own order' end;
  update public.orders set shop_id = sh2 where id = o1u; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS student: cannot move own order to another shop' else 'FAIL student: moved order' end;
  begin delete from public.orders where id = o1u; r := r || 'FAIL student: deleted order'; exception when insufficient_privilege then r := r || 'PASS student: cannot delete orders'; end;
  begin insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count) values (o1u, stu::text||'/x.pdf','x','application/pdf',1,1);
        r := r || 'FAIL student: inserted order_files directly'; exception when others then r := r || 'PASS student: cannot insert order_files directly'; end;
  begin perform private.next_order_number(sh1, current_date); r := r || 'FAIL student: called private.next_order_number'; exception when insufficient_privilege then r := r || 'PASS student: private order-number helper not callable'; end;
  begin perform private.cancel_stale_unpaid_orders(); r := r || 'FAIL student: triggered the unpaid-order job'; exception when insufficient_privilege then r := r || 'PASS student: cannot trigger the unpaid-order cancellation job'; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1,'[]'); r := r || 'FAIL student: called create_order_verified (client page_count bypass)'; exception when insufficient_privilege then r := r || 'PASS student: cannot call create_order_verified directly (no client-supplied page_count path)'; end;
  begin perform public.check_rate_limit('x', 1, 1);       r := r || 'FAIL student: check_rate_limit'; exception when insufficient_privilege then r := r || 'PASS student: cannot touch rate limiter'; end;
  begin perform public.attach_payment_order(o1u, stu, 'order_ABCdef123456'); r := r || 'FAIL student: attached a payment order'; exception when insufficient_privilege then r := r || 'PASS student: cannot attach gateway orders'; end;
  begin perform public.process_payment_event('razorpay','e','payment.captured','order_x','pay_x',1,'INR','{}'); r := r || 'FAIL student: forged a payment event'; exception when insufficient_privilege then r := r || 'PASS student: cannot mark an order PAID via payment event function'; end;
  begin perform public.files_due_for_purge(10); r := r || 'FAIL student: purge list'; exception when insufficient_privilege then r := r || 'PASS student: purge helpers denied'; end;
  begin perform public.mark_files_purged(array[gen_random_uuid()]); r := r || 'FAIL student: mark purged'; exception when insufficient_privilege then r := r || 'PASS student: cannot mark files purged'; end;
  begin perform public.cancel_order(o2); r := r || 'FAIL cancel_order: cancelled another student''s order'; exception when others then r := r || 'PASS cancel_order: other student''s order -> not found'; end;
  begin perform public.cancel_order(gen_random_uuid()); r := r || 'FAIL cancel_order: random id'; exception when others then r := r || 'PASS cancel_order: random id -> not found'; end;

  -- SHOPKEEPER (real account, shop abc-xerox)
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', shk, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.orders where id = o2;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot read another shop''s order' else 'FAIL shopkeeper: read other shop order' end;
  select count(*) into n from public.orders where id = o1u;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot see UNPAID orders of own shop' else 'FAIL shopkeeper: sees unpaid order' end;
  select count(*) into n from public.orders where id in (o1, o3);
  r := r || case when n = 2 then 'PASS shopkeeper: sees paid orders of own shop' else 'FAIL shopkeeper: own-shop orders n=' || n end;
  select count(*) into n from public.order_files where order_id in (o2, o1u);
  r := r || case when n = 0 then 'PASS shopkeeper: no files rows of other shop / unpaid order' else 'FAIL shopkeeper: reads foreign order_files' end;
  select count(*) into n from public.order_files where order_id in (o1, o3);
  r := r || case when n = 2 then 'PASS shopkeeper: reads own shop''s order_files' else 'FAIL shopkeeper: own order_files n=' || n end;
  select count(*) into n from storage.objects where bucket_id = 'print-files';
  r := r || case when n = 2 then 'PASS shopkeeper: storage limited to files of own shop''s PAID orders (2 of 5)' else 'FAIL shopkeeper: storage objects n=' || n end;
  select count(*) into n from storage.objects where name = stu2::text || '/up2/b.pdf';
  r := r || case when n = 0 then 'PASS shopkeeper: other shop''s file not readable by exact path' else 'FAIL shopkeeper: read other shop file' end;
  update public.orders set status = 'ACCEPTED' where id = o2; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot modify another shop''s order' else 'FAIL shopkeeper: modified other shop order' end;
  begin update public.orders set total_paise = 1, rate_per_sheet_paise = 1 where id = o1; r := r || 'FAIL shopkeeper: changed price'; exception when others then r := r || 'PASS shopkeeper: cannot change order price'; end;
  begin update public.orders set payment_status = 'REFUND_PENDING' where id = o1;          r := r || 'FAIL shopkeeper: changed payment_status'; exception when others then r := r || 'PASS shopkeeper: cannot change payment_status'; end;
  begin update public.orders set student_id = shk where id = o1;                            r := r || 'FAIL shopkeeper: changed student_id'; exception when others then r := r || 'PASS shopkeeper: cannot change student_id'; end;
  begin update public.orders set shop_id = sh2 where id = o1;                               r := r || 'FAIL shopkeeper: moved order to another shop'; exception when others then r := r || 'PASS shopkeeper: cannot move an order to another shop'; end;
  begin update public.orders set status = 'CANCELLED', status_reason = 'x' where id = o3;   r := r || 'FAIL shopkeeper: cancelled PENDING order'; exception when others then r := r || 'PASS shopkeeper: cannot cancel a PENDING order (reject instead)'; end;
  begin update public.orders set status = 'COMPLETED' where id = o3;                        r := r || 'FAIL shopkeeper: skipped status flow'; exception when others then r := r || 'PASS shopkeeper: cannot skip status flow'; end;
  update public.orders set status = 'ACCEPTED' where id = o3; get diagnostics n = row_count;
  r := r || case when n = 1 then 'PASS shopkeeper: can accept own shop''s paid order' else 'FAIL shopkeeper: cannot accept own order' end;
  begin update public.profiles set role = 'admin' where id = shk;     r := r || 'FAIL shopkeeper: self-promoted to admin'; exception when others then r := r || 'PASS shopkeeper: cannot self-promote to admin'; end;
  begin update public.profiles set shop_id = sh2 where id = shk;      r := r || 'FAIL shopkeeper: moved to another shop'; exception when others then r := r || 'PASS shopkeeper: cannot move itself to another shop'; end;
  select count(*) into n from public.profiles where id <> shk;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot read student/other profiles' else 'FAIL shopkeeper: reads other profiles n=' || n end;
  select count(*) into n from public.shops where id <> sh1;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot read other shops'' private rows' else 'FAIL shopkeeper: reads other shops' end;
  update public.shops set is_open = false where id = sh2; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot update another shop' else 'FAIL shopkeeper: updated other shop' end;
  begin update public.shops set is_verified = false, name = 'x' where id = sh1; r := r || 'FAIL shopkeeper: edited admin-only shop columns'; exception when others then r := r || 'PASS shopkeeper: admin-only shop columns protected'; end;
  update public.shops set is_open = false where id = sh1; get diagnostics n = row_count;
  r := r || case when n = 1 then 'PASS shopkeeper: can toggle own shop open/closed' else 'FAIL shopkeeper: cannot toggle own shop' end;
  update public.shop_pricing set price_paise = 1 where shop_id = sh1; get diagnostics n = row_count;
  r := r || case when n = 0 then 'PASS shopkeeper: cannot change prices (admin only in MVP)' else 'FAIL shopkeeper: changed prices' end;
  select count(*) into n from public.notifications where user_id in (stu, stu2);
  r := r || case when n = 0 then 'PASS shopkeeper: cannot read students'' notifications' else 'FAIL shopkeeper: reads student notifications' end;
  select count(*) into n from public.payment_events;   r := r || case when n = 0 then 'PASS shopkeeper: payment_events hidden' else 'FAIL shopkeeper: reads payment_events' end;
  select count(*) into n from public.order_counters;   r := r || case when n = 0 then 'PASS shopkeeper: order_counters hidden' else 'FAIL shopkeeper: reads order_counters' end;
  begin perform public.create_order_verified(shk, sh1,'bw','a4','single',1,'[]'); r := r || 'FAIL shopkeeper: create_order_verified'; exception when insufficient_privilege then r := r || 'PASS shopkeeper: cannot create orders / call admin RPCs'; end;
  begin perform public.cancel_order(o1); r := r || 'FAIL shopkeeper: cancel_order on student order'; exception when others then r := r || 'PASS shopkeeper: cancel_order on a student''s order -> not found'; end;
  begin perform public.process_payment_event('razorpay','e2','payment.captured','order_x','pay_x',1,'INR','{}'); r := r || 'FAIL shopkeeper: payment event fn'; exception when insufficient_privilege then r := r || 'PASS shopkeeper: cannot mark orders PAID'; end;

  -- shopkeeper 2 (fixture) must not see shop 1
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', shk2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.orders where id = o2;  r := r || case when n = 1 then 'PASS shopkeeper2: sees own shop''s order' else 'FAIL shopkeeper2: own order n=' || n end;
  select count(*) into n from public.orders where id in (o1, o3); r := r || case when n = 0 then 'PASS shopkeeper2: cannot see shop 1''s orders' else 'FAIL shopkeeper2: sees shop 1 orders' end;
  select count(*) into n from storage.objects where bucket_id = 'print-files'; r := r || case when n = 1 then 'PASS shopkeeper2: storage limited to own shop''s file only' else 'FAIL shopkeeper2: storage n=' || n end;

  -- ADMIN (real account)
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.orders where id in (o1, o1u, o2, o3);
  r := r || case when n = 4 then 'PASS admin: reads all orders' else 'FAIL admin: orders n=' || n end;
  select count(*) into n from public.payment_events; r := r || case when n >= 1 then 'PASS admin: reads payment_events' else 'FAIL admin: payment_events' end;
  update public.shops set sort_order = 99 where id = sh2; get diagnostics n = row_count;
  r := r || case when n = 1 then 'PASS admin: can edit shops' else 'FAIL admin: cannot edit shops' end;
  begin update public.profiles set shop_id = sh1 where id = adm; r := r || 'FAIL admin: linked to a shop'; exception when check_violation then r := r || 'PASS admin: cannot be linked to a shop'; end;
  begin perform public.process_payment_event('razorpay','e3','payment.captured','order_x','pay_x',1,'INR','{}'); r := r || 'FAIL admin(browser role): payment fn'; exception when insufficient_privilege then r := r || 'PASS admin via browser still cannot call service-role-only functions'; end;
  reset role;

  -- structure
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'public_shops'
     and column_name in ('phone','is_verified','deleted_at','created_at','updated_at','order_prefix');
  r := r || case when n = 0 then 'PASS public_shops exposes no phone / admin / internal columns' else 'FAIL public_shops leaks internal columns' end;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('public','private') and p.prosecdef and not coalesce(p.proconfig::text, '') like '%search_path%';
  r := r || case when n = 0 then 'PASS every SECURITY DEFINER function pins search_path' else 'FAIL SECURITY DEFINER without search_path: ' || n end;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname in ('public','private') and c.relkind = 'r' and not c.relrowsecurity;
  r := r || case when n = 0 then 'PASS RLS enabled on every public/private table' else 'FAIL tables without RLS: ' || n end;
  select count(*) into n from storage.buckets where id = 'print-files' and not public and file_size_limit = 26214400
     and allowed_mime_types @> array['application/pdf','image/png','image/jpeg'] and cardinality(allowed_mime_types) = 3;
  r := r || case when n = 1 then 'PASS print-files bucket is private, 25 MB, pdf/png/jpeg only' else 'FAIL print-files bucket config' end;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute');
  r := r || case when n = 1 and has_function_privilege('authenticated', 'public.cancel_order(uuid)', 'execute')
             then 'PASS the only function signed-in browsers can call is cancel_order' else 'FAIL browser-callable function set changed: ' || n end;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute');
  r := r || case when n = 0 then 'PASS anonymous callers can execute no public function' else 'FAIL anon can execute ' || n || ' functions' end;
  select count(*) into n from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' and table_name <> 'public_shops';
  r := r || case when n = 0 then 'PASS anon has table privileges only on public_shops' else 'FAIL anon has other table grants: ' || n end;

  raise exception E'PART A REPORT (everything rolled back)%\n-- FAIL count: %', regexp_replace(r, '(PASS|FAIL) ', E'\n\\1 ', 'g'),
    (length(r) - length(replace(r, 'FAIL ', ''))) / 5;
end $$;


-- ===================================== PART B: functions / payments / jobs ====
do $$
declare
  stu   uuid := 'b0525bd1-1533-414a-9463-c6cd16bf5d8e';
  stu2  uuid := '00000000-0000-4000-8000-0000000000a2';
  sh1   uuid; sh2 uuid := gen_random_uuid(); sh3 uuid := gen_random_uuid();
  pa text := 'b0525bd1-1533-414a-9463-c6cd16bf5d8e/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf';
  pi text := 'b0525bd1-1533-414a-9463-c6cd16bf5d8e/' || gen_random_uuid() || '/' || gen_random_uuid() || '.png';
  pm text := 'b0525bd1-1533-414a-9463-c6cd16bf5d8e/' || gen_random_uuid() || '/' || gen_random_uuid() || '.png';
  po text := '00000000-0000-4000-8000-0000000000a2/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf';
  f jsonb; fi jsonb; ord public.orders; ord2 public.orders;
  oP uuid; oP2 uuid; oP3 uuid; oU1 uuid; oU2 uuid; oU3 uuid; oU4 uuid; oF1 uuid; oF2 uuid; oF3 uuid; oF4 uuid;
  f1a uuid; f1b uuid; f2 uuid; f3 uuid; f4 uuid; due_n int; ts timestamptz;
  n int; r text := '';
begin
  select id into sh1 from public.shops where slug = 'abc-xerox';
  if sh1 is null then raise exception 'ABORT: shop abc-xerox missing'; end if;
  insert into auth.users (id, email, aud, role) values (stu2, 'fixture-student2@example.invalid', 'authenticated', 'authenticated');
  insert into public.shops (id, name, slug, order_prefix, is_verified, is_open) values
    (sh2, 'Fixture Shop 2', 'fixture-2', 'Y', true, false),
    (sh3, 'Fixture Shop 3', 'fixture-3', 'Z', false, true);
  insert into public.shop_pricing (shop_id, service, colour_mode, paper_size, price_paise)
    values (sh2, 'print', 'bw', 'a4', 100), (sh3, 'print', 'bw', 'a4', 100);

  -- Stored objects, as Supabase Storage records them (size + mimetype in metadata).
  insert into storage.objects (bucket_id, name, metadata) values
    ('print-files', pa, jsonb_build_object('size', 1000, 'mimetype', 'application/pdf')),
    ('print-files', pi, jsonb_build_object('size', 500,  'mimetype', 'image/png')),
    ('print-files', pm, jsonb_build_object('size', 500,  'mimetype', 'application/pdf')),
    ('print-files', po, jsonb_build_object('size', 1000, 'mimetype', 'application/pdf'));
  f  := jsonb_build_object('storage_path', pa, 'original_name', 'a.pdf', 'mime_type', 'application/pdf', 'size_bytes', 1000, 'page_count', 10);
  fi := jsonb_build_object('storage_path', pi, 'original_name', 'a.png', 'mime_type', 'image/png', 'size_bytes', 500, 'page_count', 1);

  -- who may call create_order_verified
  reset role; perform set_config('request.jwt.claims', json_build_object('sub', stu, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f)); r := r || 'FAIL browser user called create_order_verified'; exception when insufficient_privilege then r := r || 'PASS signed-in browser cannot call create_order_verified'; end;

  -- attacks (service role; each must fail with the EXPECTED code, so a rate-limit error can't fake a pass)
  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('storage_path', po)));          r := r || 'FAIL another user''s file path accepted'; exception when others then r := r || case when sqlstate = '42501' then 'PASS another user''s file path rejected' else 'FAIL another user''s path: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('storage_path', stu::text || '/../' || stu2::text || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf'))); r := r || 'FAIL path traversal accepted'; exception when others then r := r || case when sqlstate = '42501' then 'PASS path traversal rejected' else 'FAIL traversal: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('storage_path', 'loose.pdf')));    r := r || 'FAIL bucket-root path accepted'; exception when others then r := r || case when sqlstate = '42501' then 'PASS bucket-root path rejected' else 'FAIL root: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('storage_path', stu::text || '/x/y.pdf'))); r := r || 'FAIL non-uuid segments accepted'; exception when others then r := r || case when sqlstate = '42501' then 'PASS arbitrary path shape rejected' else 'FAIL shape: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('mime_type', 'image/png')));      r := r || 'FAIL mime/extension mismatch accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS invalid MIME for the extension rejected' else 'FAIL mime: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('mime_type', 'application/x-msdownload'))); r := r || 'FAIL exe MIME accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS executable MIME rejected' else 'FAIL exe: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('page_count', 9999)));              r := r || 'FAIL page_count 9999 accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS page_count 9999 rejected (max 500)' else 'FAIL 9999: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('page_count', 100000)));            r := r || 'FAIL 5-digit page_count accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS absurd page_count rejected' else 'FAIL 100000: ' || sqlstate end; end;

  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('page_count', 0)));                r := r || 'FAIL page_count 0 accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS page_count 0 rejected' else 'FAIL 0: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('page_count', -5)));               r := r || 'FAIL negative page_count accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS negative page_count rejected' else 'FAIL neg: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(fi || jsonb_build_object('page_count', 2)));               r := r || 'FAIL multi-page image accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS an image can only be 1 page' else 'FAIL img: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('size_bytes', 26214401)));         r := r || 'FAIL oversized file accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS file over 25 MB rejected' else 'FAIL size: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('size_bytes', 999)));              r := r || 'FAIL size not matching stored object accepted'; exception when others then r := r || case when sqlstate = 'P0002' then 'PASS declared size must match the stored object' else 'FAIL size mismatch: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(fi || jsonb_build_object('storage_path', pm)));          r := r || 'FAIL type not matching stored object accepted'; exception when others then r := r || case when sqlstate = 'P0002' then 'PASS declared type must match the stored object' else 'FAIL type mismatch: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('storage_path', stu::text || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf'))); r := r || 'FAIL nonexistent file accepted'; exception when others then r := r || case when sqlstate = 'P0002' then 'PASS nonexistent file rejected' else 'FAIL ghost: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('size_bytes', '1000; drop')));  r := r || 'FAIL non-numeric size accepted'; exception when others then r := r || case when sqlstate = '22023' then 'PASS non-numeric size rejected' else 'FAIL nan: ' || sqlstate end; end;

  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',0, jsonb_build_array(f));   r := r || 'FAIL copies 0'; exception when others then r := r || case when sqlstate = '22023' then 'PASS copies=0 rejected' else 'FAIL c0: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',21, jsonb_build_array(f));  r := r || 'FAIL copies 21'; exception when others then r := r || case when sqlstate = '22023' then 'PASS copies=21 rejected' else 'FAIL c21: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',2147483647, jsonb_build_array(f)); r := r || 'FAIL huge copies'; exception when others then r := r || case when sqlstate = '22023' then 'PASS absurd copies rejected' else 'FAIL cmax: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'rainbow','a4','single',1, jsonb_build_array(f)); r := r || 'FAIL bad colour'; exception when others then r := r || case when sqlstate = '22023' then 'PASS invalid colour enum rejected' else 'FAIL colour: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a5','single',1, jsonb_build_array(f));  r := r || 'FAIL bad paper'; exception when others then r := r || case when sqlstate = '22023' then 'PASS invalid paper enum rejected' else 'FAIL paper: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','triple',1, jsonb_build_array(f)); r := r || 'FAIL bad sides'; exception when others then r := r || case when sqlstate = '22023' then 'PASS invalid sides enum rejected' else 'FAIL sides: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh2,'bw','a4','single',1, jsonb_build_array(f));  r := r || 'FAIL closed shop'; exception when others then r := r || case when sqlstate = 'P0001' then 'PASS closed shop rejected' else 'FAIL closed: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh3,'bw','a4','single',1, jsonb_build_array(f));  r := r || 'FAIL unverified shop'; exception when others then r := r || case when sqlstate = 'P0002' then 'PASS unverified shop rejected' else 'FAIL unverified: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, gen_random_uuid(),'bw','a4','single',1, jsonb_build_array(f)); r := r || 'FAIL unknown shop'; exception when others then r := r || case when sqlstate = 'P0002' then 'PASS unknown shop rejected' else 'FAIL unknown shop: ' || sqlstate end; end;

  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  begin perform public.create_order_verified(null, sh1,'bw','a4','single',1, jsonb_build_array(f));  r := r || 'FAIL null user'; exception when others then r := r || case when sqlstate = '28000' then 'PASS missing user id rejected' else 'FAIL nulluser: ' || sqlstate end; end;
  begin perform public.create_order_verified(gen_random_uuid(), sh1,'bw','a4','single',1, jsonb_build_array(f)); r := r || 'FAIL unknown user'; exception when others then r := r || case when sqlstate = '42501' then 'PASS unknown/non-student user rejected' else 'FAIL unkuser: ' || sqlstate end; end;
  begin perform public.create_order_verified('37ee3d16-d5a7-4105-88f3-8485579ca862', sh1,'bw','a4','single',1, jsonb_build_array(f)); r := r || 'FAIL shopkeeper placed an order'; exception when others then r := r || case when sqlstate = '42501' then 'PASS shopkeeper account cannot place orders' else 'FAIL shk: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, '[]'::jsonb);            r := r || 'FAIL empty files'; exception when others then r := r || case when sqlstate = '22023' then 'PASS empty file list rejected' else 'FAIL empty: ' || sqlstate end; end;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, '{"a":1}'::jsonb);        r := r || 'FAIL non-array files'; exception when others then r := r || case when sqlstate = '22023' then 'PASS non-array file list rejected' else 'FAIL nonarray: ' || sqlstate end; end;

  -- legitimate 10-page PDF, double-sided x2 copies => 5 sheets x 2 = 10 sheets x 200 paise = 2000
  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  ord := public.create_order_verified(stu, sh1,'bw','a4','double',2, jsonb_build_array(f), 'please staple');
  r := r || case when ord.total_pages = 10 and ord.sheets = 10 and ord.rate_per_sheet_paise = 200 and ord.total_paise = 2000
                  and ord.student_id = stu and ord.payment_status = 'PENDING' and ord.order_number is null and ord.status = 'PENDING'
             then 'PASS legitimate 10-page PDF: price computed from DB rate (2000 paise), unpaid, no number yet'
             else 'FAIL legitimate order wrong: ' || to_jsonb(ord)::text end;
  ord2 := public.create_order_verified(stu, sh1,'bw','a4','double',2, jsonb_build_array(f), 'please staple');
  r := r || case when ord2.id = ord.id then 'PASS retry / double-submit returns the SAME order (no duplicate)' else 'FAIL retry created a second order' end;
  ord2 := public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(fi));
  r := r || case when ord2.total_pages = 1 and ord2.total_paise = 200 and ord2.sheets = 1 then 'PASS image order: one page, DB price' else 'FAIL image order: ' || to_jsonb(ord2)::text end;
  reset role;
  select count(*) into n from public.order_files where storage_path in (pa, pi);
  r := r || case when n = 2 then 'PASS exactly one file row per file (no duplicates after retry)' else 'FAIL file rows n=' || n end;

  -- rate limiting inside the database: seeded counters => RL001
  insert into private.rate_limits (key, window_start, hits) values ('create_order:' || stu::text, now(), 10)
    on conflict (key) do update set hits = 10, window_start = now();
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  begin perform public.create_order_verified(stu, sh1,'bw','a4','single',1, jsonb_build_array(f || jsonb_build_object('storage_path', stu::text || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf'))); r := r || 'FAIL order rate limit not enforced'; exception when others then r := r || case when sqlstate = 'RL001' then 'PASS order creation is rate limited (10/hour/user)' else 'FAIL order rl: ' || sqlstate end; end;
  reset role;
  insert into private.rate_limits (key, window_start, hits) values ('cancel_order:' || stu::text, now(), 20)
    on conflict (key) do update set hits = 20, window_start = now();
  perform set_config('request.jwt.claims', json_build_object('sub', stu, 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.cancel_order(ord.id); r := r || 'FAIL cancel rate limit not enforced'; exception when others then r := r || case when sqlstate = 'RL001' then 'PASS cancellation is rate limited (20/10 min/user)' else 'FAIL cancel rl: ' || sqlstate end; end;
  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', json_build_object('sub', stu, 'role', 'authenticated')::text, true); set local role authenticated;
  ord2 := public.cancel_order(ord.id);
  r := r || case when ord2.status = 'CANCELLED' and ord2.cancelled_at is not null and ord2.files_purge_after > now() + interval '6 days 23 hours' then 'PASS own PENDING order cancels; 7-day purge timer starts' else 'FAIL cancel: ' || to_jsonb(ord2)::text end;
  begin perform public.cancel_order(ord.id); r := r || 'FAIL cancelled twice'; exception when others then r := r || case when sqlstate = 'P0001' then 'PASS cannot cancel twice' else 'FAIL twice: ' || sqlstate end; end;

  -- check_rate_limit semantics
  reset role; delete from private.rate_limits;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.check_rate_limit('k1', 2, 60) and public.check_rate_limit('k1', 2, 60) and not public.check_rate_limit('k1', 2, 60) then 'PASS limiter allows N then blocks' else 'FAIL limiter logic' end;
  r := r || case when public.check_rate_limit('k2', 2, 60) then 'PASS limiter keys are independent' else 'FAIL limiter key isolation' end;
  begin perform public.check_rate_limit('k3', 0, 60); r := r || 'FAIL limiter accepted limit 0'; exception when others then r := r || case when sqlstate = '22023' then 'PASS limiter rejects bad arguments' else 'FAIL limiter args: ' || sqlstate end; end;
  reset role;
  update private.rate_limits set window_start = now() - interval '2 minutes' where key = 'k1';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.check_rate_limit('k1', 2, 60) then 'PASS limiter window resets after expiry (DB clock, not client)' else 'FAIL limiter window did not reset' end;
  reset role;

  -- payments + state machine
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1, 'bw','a4','single',1,1,1,200,200) returning id into oP;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1, 'bw','a4','single',1,1,1,200,200) returning id into oP2;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1, 'bw','a4','single',1,1,1,200,200) returning id into oP3;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  begin perform public.attach_payment_order(oP, stu2, 'order_ABCdef123456'); r := r || 'FAIL attached another user''s order'; exception when others then r := r || case when sqlstate = 'P0002' then 'PASS cannot attach payment to someone else''s order' else 'FAIL attach other: ' || sqlstate end; end;
  begin perform public.attach_payment_order(oP, stu, 'bad id; drop'); r := r || 'FAIL malformed gateway id'; exception when others then r := r || case when sqlstate = '22023' then 'PASS malformed gateway reference rejected' else 'FAIL attach fmt: ' || sqlstate end; end;
  ord := public.attach_payment_order(oP, stu, 'order_ABCdef123456');
  ord2 := public.attach_payment_order(oP, stu, 'order_ZZZzzz999999');
  r := r || case when ord.payment_order_id = 'order_ABCdef123456' and ord2.payment_order_id = 'order_ABCdef123456' then 'PASS gateway order attached once; a second attach keeps the first (idempotent)' else 'FAIL attach idempotency' end;
  perform public.attach_payment_order(oP2, stu, 'order_PAYTWO123456');
  perform public.attach_payment_order(oP3, stu, 'order_PAYTHREE12345');

  r := r || case when public.process_payment_event('razorpay','evt_a1','payment.captured','order_ABCdef123456','pay_AAA111',200,'INR','{}') = 'paid' then 'PASS verified payment.captured marks the order PAID' else 'FAIL capture not applied' end;
  reset role;
  select * into ord from public.orders where id = oP;
  r := r || case when ord.payment_status = 'PAID' and ord.order_number is not null and ord.paid_at is not null and ord.payment_id = 'pay_AAA111' then 'PASS PAID order has number, paid_at and payment id' else 'FAIL after paid: ' || to_jsonb(ord)::text end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.process_payment_event('razorpay','evt_a1','payment.captured','order_ABCdef123456','pay_AAA111',200,'INR','{}') = 'duplicate' then 'PASS replayed webhook (same event id) is a no-op' else 'FAIL replay not detected' end;
  r := r || case when public.process_payment_event('razorpay','evt_a2','order.paid','order_ABCdef123456','pay_AAA111',200,'INR','{}') = 'ignored_state' then 'PASS second event for an already-PAID order changes nothing' else 'FAIL second event applied' end;
  r := r || case when public.process_payment_event('razorpay','evt_a3','payment.failed','order_ABCdef123456','pay_AAA111',200,'INR','{}') = 'ignored_state' then 'PASS late payment.failed cannot un-pay an order' else 'FAIL failed event applied to PAID' end;
  reset role;
  select count(*) into due_n from public.payment_events where provider = 'razorpay' and event_id in ('evt_a1','evt_a2','evt_a3');
  r := r || case when due_n = 3 then 'PASS every event recorded exactly once (unique provider+event id)' else 'FAIL event rows: ' || due_n end;
  select * into ord from public.orders where id = oP;
  r := r || case when ord.payment_status = 'PAID' then 'PASS replay/duplicates left the order PAID with one order number' else 'FAIL state drifted' end;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.process_payment_event('razorpay','evt_b1','payment.captured','order_PAYTWO123456','pay_BBB',1,'INR','{}') = 'amount_mismatch' then 'PASS wrong amount is NOT accepted' else 'FAIL amount mismatch applied' end;
  r := r || case when public.process_payment_event('razorpay','evt_b2','payment.captured','order_PAYTWO123456','pay_BBB',200,'USD','{}') = 'amount_mismatch' then 'PASS wrong currency is NOT accepted' else 'FAIL currency mismatch applied' end;
  r := r || case when public.process_payment_event('razorpay','evt_b3','payment.captured','order_PAYTWO123456','pay_BBB',null,null,'{}') = 'amount_mismatch' then 'PASS missing amount/currency is NOT accepted' else 'FAIL null amount applied' end;
  r := r || case when public.process_payment_event('razorpay','evt_b4','payment.captured','order_DOESNOTEXIST','pay_X',200,'INR','{}') = 'unknown_order' then 'PASS event for an unknown gateway order changes nothing' else 'FAIL unknown order' end;
  r := r || case when public.process_payment_event('razorpay','evt_b5','something.else','order_PAYTWO123456',null,null,null,'{}') = 'ignored' then 'PASS unrelated event types are ignored' else 'FAIL unrelated event' end;
  reset role;
  select * into ord from public.orders where id = oP2;
  r := r || case when ord.payment_status = 'PENDING' and ord.paid_at is null and ord.order_number is null then 'PASS rejected events left the order PENDING/unnumbered' else 'FAIL order changed by rejected events' end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.process_payment_event('razorpay','evt_c1','payment.failed','order_PAYTHREE12345','pay_C1',200,'INR','{}') = 'failed' then 'PASS payment.failed marks a PENDING order FAILED' else 'FAIL failed event' end;
  r := r || case when public.process_payment_event('razorpay','evt_c2','payment.captured','order_PAYTHREE12345','pay_C2',200,'INR','{}') = 'paid' then 'PASS a retry payment on a FAILED order can succeed (FAILED -> PAID)' else 'FAIL FAILED->PAID' end;
  reset role;
  begin update public.orders set payment_status = 'PENDING' where id = oP; r := r || 'FAIL PAID -> PENDING allowed'; exception when check_violation then r := r || 'PASS PAID -> PENDING rejected by the state machine'; end;
  begin update public.orders set payment_status = 'FAILED' where id = oP;  r := r || 'FAIL PAID -> FAILED allowed'; exception when check_violation then r := r || 'PASS PAID -> FAILED rejected'; end;
  begin update public.orders set payment_status = 'REFUNDED' where id = oP; r := r || 'FAIL PAID -> REFUNDED skipped refund step'; exception when check_violation then r := r || 'PASS PAID -> REFUNDED (skipping REFUND_PENDING) rejected'; end;
  begin update public.orders set status = 'ACCEPTED' where id = oP2;      r := r || 'FAIL unpaid order accepted'; exception when check_violation then r := r || 'PASS an unpaid order cannot be accepted/worked on'; end;
  update public.orders set status = 'CANCELLED', status_reason = 'shop closed' where id = oP;
  select * into ord from public.orders where id = oP;
  r := r || case when ord.payment_status = 'REFUND_PENDING' and ord.refund_requested_at is not null then 'PASS cancelling a PAID order queues a refund' else 'FAIL refund not queued' end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.process_payment_event('razorpay','evt_d1','refund.processed',null,'pay_AAA111',200,'INR','{}') = 'refunded' then 'PASS verified refund.processed completes the refund' else 'FAIL refund event' end;
  reset role;
  select * into ord from public.orders where id = oP;
  r := r || case when ord.payment_status = 'REFUNDED' and ord.refunded_at is not null then 'PASS order is REFUNDED with timestamp' else 'FAIL refund state' end;

  -- 24 h unpaid-order cancellation
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oU1;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oU2;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oU3;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oU4;
  update public.orders set payment_status = 'PAID' where id = oU2;
  update public.orders set payment_status = 'FAILED' where id = oU4;
  update public.orders set created_at = now() - interval '25 hours' where id in (oU1, oU2, oU4);
  update public.orders set created_at = now() - interval '23 hours' where id = oU3;
  n := private.cancel_stale_unpaid_orders();
  r := r || case when n >= 2 then 'PASS unpaid-order job ran' else 'FAIL job returned ' || n end;
  select count(*) into n from public.orders where id in (oU1, oU4) and status = 'CANCELLED' and cancelled_at is not null and status_reason = 'Not paid within 24 hours' and files_purge_after between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour';
  r := r || case when n = 2 then 'PASS stale unpaid/failed orders cancelled; cancelled_at set; 7-day purge timer starts at cancellation' else 'FAIL stale cancellation n=' || n end;
  select count(*) into n from public.orders where id = oU2 and status = 'PENDING' and payment_status = 'PAID' and cancelled_at is null;
  r := r || case when n = 1 then 'PASS a PAID order is NEVER cancelled by the job' else 'FAIL job touched a paid order' end;
  select count(*) into n from public.orders where id = oU3 and status = 'PENDING' and cancelled_at is null;
  r := r || case when n = 1 then 'PASS a 23-hour-old unpaid order is left alone' else 'FAIL job cancelled a recent order' end;
  r := r || case when private.cancel_stale_unpaid_orders() = 0 then 'PASS job is idempotent (second run cancels nothing)' else 'FAIL job not idempotent' end;
  select count(*) into n from cron.job where jobname = 'campusprint-cancel-unpaid-orders' and active and schedule = '*/10 * * * *';
  r := r || case when n = 1 then 'PASS pg_cron job campusprint-cancel-unpaid-orders is active (every 10 min)' else 'FAIL cron job missing/inactive' end;
  select count(*) into n from cron.job where jobname = 'campusprint-prune-rate-limits' and active;
  r := r || case when n = 1 then 'PASS pg_cron job campusprint-prune-rate-limits is active' else 'FAIL prune job missing' end;

  -- file purge safety
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oF1;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oF2;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oF3;
  insert into public.orders (student_id, shop_id, colour_mode, paper_size, sides, copies, total_pages, sheets, rate_per_sheet_paise, total_paise)
    values (stu, sh1,'bw','a4','single',1,1,1,200,200) returning id into oF4;
  update public.orders set payment_status = 'PAID' where id in (oF1, oF2, oF3);
  update public.orders set status = 'ACCEPTED' where id in (oF1, oF2, oF3);
  update public.orders set status = 'PRINTING' where id in (oF1, oF2);
  update public.orders set status = 'READY'    where id in (oF1, oF2);
  update public.orders set status = 'COMPLETED' where id in (oF1, oF2);
  update public.orders set files_purge_after = now() - interval '1 day' where id = oF1;
  insert into public.order_files (order_id, storage_path, original_name, mime_type, size_bytes, page_count) values
    (oF1, stu::text || '/' || gen_random_uuid() || '/f1a.pdf', 'f1a', 'application/pdf', 10, 1),
    (oF1, stu::text || '/' || gen_random_uuid() || '/f1b.pdf', 'f1b', 'application/pdf', 10, 1),
    (oF2, stu::text || '/' || gen_random_uuid() || '/f2.pdf',  'f2',  'application/pdf', 10, 1),
    (oF3, stu::text || '/' || gen_random_uuid() || '/f3.pdf',  'f3',  'application/pdf', 10, 1),
    (oF4, stu::text || '/' || gen_random_uuid() || '/f4.pdf',  'f4',  'application/pdf', 10, 1);
  select id into f1a from public.order_files where order_id = oF1 and original_name = 'f1a';
  select id into f1b from public.order_files where order_id = oF1 and original_name = 'f1b';
  select id into f2  from public.order_files where order_id = oF2;
  select id into f3  from public.order_files where order_id = oF3;
  select id into f4  from public.order_files where order_id = oF4;
  insert into storage.objects (bucket_id, name, created_at) values
    ('print-files', stu::text || '/' || gen_random_uuid() || '/orphan-old.pdf', now() - interval '48 hours'),
    ('print-files', stu::text || '/' || gen_random_uuid() || '/orphan-new.pdf', now());
  insert into storage.objects (bucket_id, name, created_at)
    select 'print-files', storage_path, now() - interval '48 hours' from public.order_files where order_id = oF3;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  select count(*) into due_n from public.files_due_for_purge(100) d where d.file_id in (f1a, f1b);
  r := r || case when due_n = 2 then 'PASS purge selects the files of a COMPLETED order past 7 days' else 'FAIL purge missed due files' end;
  select count(*) into due_n from public.files_due_for_purge(100) d where d.file_id in (f2, f3, f4);
  r := r || case when due_n = 0 then 'PASS purge never selects: completed-but-within-7-days, ACTIVE, or unpaid-pending orders'' files' else 'FAIL purge selected protected files: ' || due_n end;
  select count(*) into due_n from public.orphan_uploads(interval '24 hours', 100) where storage_path like '%orphan-old.pdf';
  r := r || case when due_n = 1 then 'PASS 48h-old unattached upload is an orphan' else 'FAIL old orphan not found' end;
  select count(*) into due_n from public.orphan_uploads(interval '24 hours', 100) where storage_path like '%orphan-new.pdf' or storage_path in (select storage_path from public.order_files where order_id = oF3);
  r := r || case when due_n = 0 then 'PASS a fresh upload and uploads attached to an order are never orphans' else 'FAIL orphan list too broad: ' || due_n end;
  r := r || case when public.mark_files_purged(array[f3, f2, f4]) = 0 then 'PASS marking files of active/within-retention/unpaid orders as purged does nothing' else 'FAIL protected files marked purged' end;
  r := r || case when public.mark_files_purged(array[f1a]) = 1 then 'PASS first file of a finished order recorded as purged' else 'FAIL mark f1a' end;
  reset role;
  select count(*) into n from public.orders where id = oF1 and files_purged_at is null;
  r := r || case when n = 1 then 'PASS order is not marked purged while one of its files remains' else 'FAIL order marked purged early' end;
  select file_deleted_at into ts from public.order_files where id = f1a;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role;
  r := r || case when public.mark_files_purged(array[f1a, f1b]) = 2 then 'PASS purge is idempotent (re-marking is harmless)' else 'FAIL re-mark' end;
  select count(*) into due_n from public.files_due_for_purge(100) d where d.file_id in (f1a, f1b);
  r := r || case when due_n = 0 then 'PASS purged files no longer appear in the due list' else 'FAIL purged files still due' end;
  reset role;
  select count(*) into n from public.orders where id = oF1 and files_purged_at is not null;
  r := r || case when n = 1 then 'PASS orders.files_purged_at recorded once all files are gone' else 'FAIL files_purged_at not set' end;
  select count(*) into n from public.order_files where id = f1a and file_deleted_at = ts;
  r := r || case when n = 1 then 'PASS original deletion timestamp preserved on re-run' else 'FAIL timestamp overwritten' end;
  select count(*) into n from public.order_files where id in (f2, f3, f4) and file_deleted_at is not null;
  r := r || case when n = 0 then 'PASS no protected file was marked deleted' else 'FAIL protected file marked deleted' end;

  raise exception E'PART B REPORT (everything rolled back)%\n-- FAIL count: %', regexp_replace(r, '(PASS|FAIL) ', E'\n\\1 ', 'g'),
    (length(r) - length(replace(r, 'FAIL ', ''))) / 5;
end $$;
