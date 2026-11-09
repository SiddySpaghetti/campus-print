-- =============================================================================
-- CampusPrint — new orders are accept-then-pay
-- =============================================================================
-- Step 2 of 3. NOT in supabase/migrations on purpose: apply only after the new app is deployed and verified.
-- One catalog change, no rows touched: this is the release switch. Orders already
-- placed keep the flow they were created with.
-- =============================================================================

alter table public.orders alter column accept_first set default true;
