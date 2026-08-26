-- =====================================================================
-- 0001  Foundation: extensions, app schema, privilege lockdown
-- Spec: rate-hub-spec-v2-1 §11.1, §12.2
--
-- This migration runs FIRST so that every table and function created by
-- later migrations is born with no privilege granted to anon/authenticated.
-- §12.2: "Every function created after this point starts with no execute
-- privilege and is granted explicitly."
-- =====================================================================

-- --- Extensions -------------------------------------------------------
-- Installed into `extensions` (Supabase convention) rather than `public`,
-- so the business schema holds only business objects.
create extension if not exists citext      with schema extensions;
create extension if not exists btree_gist  with schema extensions;   -- band exclusion constraints

-- --- The app schema ---------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;

-- --- Existing objects: revoke -----------------------------------------
revoke all     on all tables    in schema public from anon, authenticated;
revoke all     on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app    from public, anon, authenticated;

-- --- Future objects: revoke defaults ----------------------------------
-- DEVIATION FROM SPEC §12.2, deliberate and strictly safer.
--
-- The spec revokes default EXECUTE from `public` only. On Supabase that is
-- insufficient: the platform ships a default-ACL entry owned by `postgres`
-- that grants EXECUTE to `anon`, `authenticated` and `service_role` BY NAME,
-- not via PUBLIC. Revoking from PUBLIC alone therefore leaves every future
-- function directly executable by anon and authenticated -- precisely the
-- defect §12.2 exists to make impossible. We revoke from all three principals.
--
-- Verified against pg_default_acl on this project before writing:
--   grantor=postgres schema=public objtype=f
--     acl={postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,...}
--
-- These statements bind to the CURRENT role (postgres), which is the role
-- migrations execute as, and therefore the role that will own every object
-- created below. T26 proves the result empirically.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app    revoke execute on functions from public, anon, authenticated;

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema app    revoke all on tables    from anon, authenticated;

alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema app    revoke all on sequences from anon, authenticated;
