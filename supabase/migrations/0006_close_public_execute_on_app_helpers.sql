-- =====================================================================
-- 0006  Close PUBLIC EXECUTE on the app.* helpers created by 0005
-- Spec §12.2, test T26
--
-- T26 went red immediately after 0005: the four RLS helper functions carried
-- the Postgres built-in default of EXECUTE to PUBLIC ({=X/postgres,...}).
-- 0001's ALTER DEFAULT PRIVILEGES recorded an entry for schema `public`
-- (which already had one from the platform) but recorded nothing for the
-- freshly created schema `app`, so the built-in default applied there.
--
-- This migration fixes the functions that already exist. 0007 makes the
-- guarantee structural for every function created afterwards -- see
-- docs/spec-findings.md F1 for why default privileges alone do not hold.
-- =====================================================================

revoke execute on all functions in schema app from public, anon;

alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app revoke execute on functions from anon;
alter default privileges in schema app revoke execute on functions from authenticated;

revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- The helpers must remain executable by `authenticated`: RLS policy
-- expressions are evaluated as the querying role (§12.4).
grant execute on function
  app.principal_id(), app.staff_role(), app.partner_id(), app.partner_role()
  to authenticated;
