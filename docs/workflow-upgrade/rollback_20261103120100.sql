-- ROLLBACK of 20261103120100_accept_first_default_on. The release switch back off.
-- New orders are pay-first again; orders placed since stay accept_first and need
-- the new app to finish. Then: supabase migration repair --status reverted 20261103120100
alter table public.orders alter column accept_first set default false;
