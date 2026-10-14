-- =============================================================================
-- CampusPrint — per-shop online payment switch
-- =============================================================================
-- Second half of the online-payment gate (lib/server/razorpay.ts): a shop gets
-- ONLINE (Razorpay) orders only if its id equals the server env var
-- RAZORPAY_ENABLED_SHOP_ID (Sitaram Prints, whose merchant keys are configured)
-- AND online_payment = true. Every other shop stays PAY_AT_COUNTER. The flag is
-- the admin's off switch without a redeploy. The order API reads it with the
-- service role; the public_shops view does not expose it. Admin-only: shops_guard already
-- blocks shopkeepers from changing anything but is_open and prep_minutes.
-- =============================================================================

alter table public.shops
  add column online_payment boolean not null default false;
