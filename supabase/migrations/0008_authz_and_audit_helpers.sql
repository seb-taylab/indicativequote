-- =====================================================================
-- 0008  Caller resolution, authorisation, and the audit writer
-- Spec §13 preamble, §11.7
--
-- "Every function is SECURITY DEFINER, carries set search_path = '',
--  schema-qualifies every object, resolves the caller through
--  app.principal_id(), raises on an unauthorised caller, validates tenant
--  consistency across every id it touches, and writes its audit event inside
--  the same transaction as its effect."
--
-- These helpers are how each of those clauses is honoured once rather than
-- twenty times. An RPC that forgets to call require_staff() is a bug a
-- reviewer can see; twenty RPCs each reimplementing the role check is a bug
-- nobody sees until one of them is wrong.
--
-- NOTE ON citext AND AN EMPTY search_path.
-- Operator lookup uses search_path, and citext's operators live in the
-- `extensions` schema, so `email = 'x'` would fail to resolve inside these
-- functions. Comparisons are therefore written over email::text, which uses
-- text operators from pg_catalog and is always visible. Case-insensitive
-- semantics are preserved explicitly with lower(); the citext column keeps
-- enforcing uniqueness.
-- =====================================================================

create type app.actor_t as (
  principal_id uuid,
  email        text,
  kind         text,
  staff_role   text,
  partner_id   uuid,
  partner_role text
);

-- The caller, resolved once. A null principal_id means "no active principal",
-- which covers the revoked and the never-invited case alike (TM8).
create or replace function app.actor() returns app.actor_t
language sql stable security definer
set search_path = ''
as $$
  select row(p.id,
             p.email::text,
             p.kind,
             sp.role,
             pm.partner_id,
             pm.role)::app.actor_t
    from public.principals p
    left join public.staff_profiles      sp on sp.principal_id = p.id
    left join public.partner_memberships pm on pm.principal_id = p.id
   where p.auth_user_id = auth.uid()
     and p.status = 'active'
$$;

-- Raises unless the caller is active staff holding one of p_allowed.
-- errcode 42501 (insufficient_privilege) so PostgREST answers 403 rather than
-- a 500 that reads like an outage.
create or replace function app.require_staff(p_allowed text[])
returns app.actor_t
language plpgsql stable security definer
set search_path = ''
as $$
declare a app.actor_t;
begin
  a := app.actor();
  if a.principal_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if a.staff_role is null or not (a.staff_role = any(p_allowed)) then
    raise exception 'requires one of: %', array_to_string(p_allowed, ', ')
      using errcode = '42501';
  end if;
  return a;
end
$$;

-- Raises unless the caller is an active partner principal holding one of
-- p_allowed. Returns the caller's own partner_id, which every partner RPC
-- uses as the tenant boundary -- never a partner_id supplied by the client.
create or replace function app.require_partner(p_allowed text[])
returns app.actor_t
language plpgsql stable security definer
set search_path = ''
as $$
declare a app.actor_t;
begin
  a := app.actor();
  if a.principal_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if a.partner_id is null or a.partner_role is null
     or not (a.partner_role = any(p_allowed)) then
    raise exception 'requires one of: %', array_to_string(p_allowed, ', ')
      using errcode = '42501';
  end if;
  return a;
end
$$;

-- The audit writer. Called inside the same transaction as the effect it
-- records, never after it (§13). audit_events grants no INSERT to any
-- application role and has no INSERT policy; this inserts because it runs as
-- the table owner, which is the whole point of the RPC-only design (D2).
--
-- §18.4: detail is structured keys only -- never a rendered sentence
-- containing an address, or a deletion request cannot find it.
create or replace function app.audit(
  p_actor        app.actor_t,
  p_action       text,
  p_subject_type text,
  p_subject_id   text,
  p_partner_id   uuid  default null,
  p_detail       jsonb default '{}'::jsonb
) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.audit_events
    (actor_id, actor_email, actor_role, action, subject_type, subject_id, partner_id, detail)
  values
    ((p_actor).principal_id,
     (p_actor).email::extensions.citext,
     coalesce((p_actor).staff_role, (p_actor).partner_role),
     p_action, p_subject_type, p_subject_id, p_partner_id, p_detail)
$$;

-- Internal plumbing. 0007's event trigger has already revoked PUBLIC and anon;
-- nothing grants these to `authenticated`, so they are reachable only from
-- other SECURITY DEFINER functions.
revoke execute on function
  app.actor(),
  app.require_staff(text[]),
  app.require_partner(text[]),
  app.audit(app.actor_t, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
