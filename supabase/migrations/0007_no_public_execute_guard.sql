-- =====================================================================
-- 0007  Structural guarantee that no function is executable by PUBLIC
-- Spec §12.2, threat TM6, test T26
--
-- WHY THIS EXISTS -- a defect in the specification, found by testing.
--
-- §12.2 relies on ALTER DEFAULT PRIVILEGES to ensure "every function created
-- after this point starts with no execute privilege". Verified empirically on
-- this project: it does not work. A function created in schema `public` after
-- 0001 came out with
--     {=X/postgres,postgres=X/postgres,service_role=X/postgres}
-- The leading `=X` is PUBLIC holding EXECUTE. Postgres re-applies the built-in
-- default for functions on top of the stored pg_default_acl row, and for the
-- freshly created schema `app` it recorded no row at all.
--
-- Consequence had this shipped as specified: every RPC in §13 -- the entire
-- write surface, including invite_staff and create_markup_version -- would be
-- executable by `anon` and by any signed-in user the moment it was created,
-- with the role check inside the function as the only thing standing between
-- an anonymous caller and a privileged mutation. That is precisely the class
-- of defect §12.2 says "cannot recur", and T26 is the test that catches it.
--
-- The fix is structural rather than procedural: an event trigger revokes
-- EXECUTE from PUBLIC and anon on every function created in public or app,
-- at the moment it is created. Nothing depends on a developer remembering to
-- write a REVOKE, which is the failure mode the spec was already trying to
-- design out. Explicit grants to `authenticated` are unaffected.
-- =====================================================================

create or replace function app.revoke_public_execute() returns event_trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  obj record;
begin
  for obj in
    select object_identity, schema_name
      from pg_catalog.pg_event_trigger_ddl_commands()
     where command_tag in ('CREATE FUNCTION')
       and schema_name in ('public','app')
  loop
    execute format('revoke execute on function %s from public', obj.object_identity);
    execute format('revoke execute on function %s from anon',   obj.object_identity);
  end loop;
end
$$;

revoke execute on function app.revoke_public_execute() from public, anon, authenticated;

drop event trigger if exists no_public_execute;
create event trigger no_public_execute
  on ddl_command_end
  when tag in ('CREATE FUNCTION')
  execute function app.revoke_public_execute();

-- Sweep the functions that already exist, since the trigger only fires on
-- creations from here on.
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema app    from public, anon;

-- The RLS helpers must stay executable by `authenticated`: policy expressions
-- are evaluated as the querying role (§12.4).
grant execute on function
  app.principal_id(), app.staff_role(), app.partner_id(), app.partner_role()
  to authenticated;
