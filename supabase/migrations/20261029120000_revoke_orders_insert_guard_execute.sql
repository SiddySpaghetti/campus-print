-- =============================================================================
-- CampusPrint — orders_insert_guard: no EXECUTE for API roles
-- =============================================================================
-- 20261025120100_printing_only_via_download created private.orders_insert_guard()
-- without revoking Postgres's default PUBLIC EXECUTE, unlike every other trigger
-- function in private. Not exploitable (a trigger function can't be called
-- directly: 0A000), so this only brings it in line. The trigger keeps firing:
-- Postgres checks EXECUTE when a trigger is created, not when it fires.
-- =============================================================================

revoke execute on function private.orders_insert_guard() from public, anon, authenticated;
