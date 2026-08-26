-- =====================================================================
-- 0012  Identity: the split invite and revoke paths
-- Spec §13.2, threats TM4 and TM5, tests T16 to T19
--
-- This migration exists to close two real failures in V2, which are worth
-- restating because the shape of the code here is a direct consequence:
--
-- TM4, escalation by invitation. V2 gave backbone_operator a single
--   invite_principal(p_email, p_kind, p_role, ...)
-- so an operator could invite an address they controlled as backbone_admin and
-- sign in with it. `invite_staff` is therefore admin-only, and it is the ONLY
-- path in the entire RPC surface that creates a staff principal or assigns a
-- staff role. An operator cannot create a staff principal at all.
--
-- TM5, lockout by revocation. The mirror image: an operator or a mistaken
-- admin removes every admin, after which no markup version can ever be created
-- and the board prices nothing. revoke_staff refuses the last active
-- backbone_admin, and refuses self.
--
-- D15: there is deliberately no invite_partner_colleague. Backbone owns all
-- access management, so every person who can see a partner's book has been
-- vetted by MetaComp.
-- =====================================================================

-- Shared: does this address already exist as any principal, of any kind?
-- §13.2 requires both invite paths to refuse a duplicate, and a partner and a
-- staff principal sharing an address would defeat D11's class exclusivity.
create or replace function app.principal_exists(p_email text)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id from public.principals p
   where lower(p.email::text) = lower(trim(p_email))
$$;

revoke execute on function app.principal_exists(text) from public, anon, authenticated;

-- --- Partner access, operator and above -------------------------------
create or replace function public.invite_partner_user(
  p_email      text,
  p_role       text,
  p_partner_id uuid
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_id uuid; v_email text := lower(trim(p_email));
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  if p_role not in ('partner_user','partner_admin') then
    raise exception 'role must be partner_user or partner_admin'
      using errcode = '22023';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'not a valid e-mail address' using errcode = '22023';
  end if;

  if not exists (select 1 from public.partners where id = p_partner_id) then
    raise exception 'no such partner' using errcode = '23503';
  end if;

  -- Refuses an address that exists as ANY principal, staff included. Without
  -- this an operator could "invite" an existing admin's address and, if the
  -- insert were permissive, attach a partner membership to a staff principal.
  if app.principal_exists(v_email) is not null then
    raise exception 'that address is already a principal' using errcode = '23505';
  end if;

  -- kind is hard-coded 'partner'. It is not a parameter, so there is no value
  -- an operator can pass that produces a staff principal (TM4).
  insert into public.principals (email, kind, status, invited_by)
  values (v_email::extensions.citext, 'partner', 'invited', a.principal_id)
  returning id into v_id;

  insert into public.partner_memberships (principal_id, partner_id, role)
  values (v_id, p_partner_id, p_role);

  perform app.audit(a, 'access.invite', 'principal', v_id::text, p_partner_id,
                    jsonb_build_object('kind', 'partner', 'role', p_role));

  return jsonb_build_object('principal_id', v_id, 'kind', 'partner', 'role', p_role);
end
$$;

create or replace function public.revoke_partner_user(
  p_principal_id uuid,
  p_reason       text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_kind text; v_status text; v_partner uuid;
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  select p.kind, p.status, pm.partner_id into v_kind, v_status, v_partner
    from public.principals p
    left join public.partner_memberships pm on pm.principal_id = p.id
   where p.id = p_principal_id;

  if v_kind is null then
    raise exception 'no such principal' using errcode = '23503';
  end if;

  -- T17. An operator must not be able to reach a staff principal through the
  -- partner path, which is how a "partner admin" tool becomes a staff tool.
  if v_kind <> 'partner' then
    raise exception 'that principal is staff; use revoke_staff'
      using errcode = '42501';
  end if;

  if v_status = 'revoked' then
    return jsonb_build_object('principal_id', p_principal_id, 'status', 'revoked',
                              'already_revoked', true);
  end if;

  update public.principals
     set status = 'revoked', revoked_at = now(), revoked_by = a.principal_id
   where id = p_principal_id;

  -- §18.4: structured keys only, and the reason is a caller-supplied string --
  -- recorded as its own key so a deletion request can find it.
  perform app.audit(a, 'access.revoke', 'principal', p_principal_id::text, v_partner,
                    jsonb_build_object('kind', 'partner', 'reason', p_reason));

  return jsonb_build_object('principal_id', p_principal_id, 'status', 'revoked');
end
$$;

-- --- Staff access, admin only -----------------------------------------
-- The only path that creates a staff principal or assigns a staff role.
create or replace function public.invite_staff(
  p_email text,
  p_role  text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_id uuid; v_email text := lower(trim(p_email));
begin
  a := app.require_staff(array['backbone_admin']);

  if p_role not in ('rm_viewer','backbone_operator','backbone_admin') then
    raise exception 'role must be rm_viewer, backbone_operator or backbone_admin'
      using errcode = '22023';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'not a valid e-mail address' using errcode = '22023';
  end if;

  if app.principal_exists(v_email) is not null then
    raise exception 'that address is already a principal' using errcode = '23505';
  end if;

  insert into public.principals (email, kind, status, invited_by)
  values (v_email::extensions.citext, 'staff', 'invited', a.principal_id)
  returning id into v_id;

  insert into public.staff_profiles (principal_id, role) values (v_id, p_role);

  perform app.audit(a, 'access.invite', 'principal', v_id::text, null,
                    jsonb_build_object('kind', 'staff', 'role', p_role));

  return jsonb_build_object('principal_id', v_id, 'kind', 'staff', 'role', p_role);
end
$$;

create or replace function public.set_staff_role(
  p_principal_id uuid,
  p_role         text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_prev text; v_admins integer;
begin
  a := app.require_staff(array['backbone_admin']);

  if p_role not in ('rm_viewer','backbone_operator','backbone_admin') then
    raise exception 'role must be rm_viewer, backbone_operator or backbone_admin'
      using errcode = '22023';
  end if;

  -- Refuses self. An admin demoting themselves is the commonest way to arrive
  -- at zero admins without ever calling revoke_staff.
  if p_principal_id = a.principal_id then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;

  select sp.role into v_prev
    from public.staff_profiles sp where sp.principal_id = p_principal_id;
  if v_prev is null then
    raise exception 'no such staff principal' using errcode = '23503';
  end if;

  -- The lockout guard has to cover demotion too, not only revocation (TM5).
  if v_prev = 'backbone_admin' and p_role <> 'backbone_admin' then
    select count(*) into v_admins
      from public.staff_profiles sp
      join public.principals p on p.id = sp.principal_id
     where sp.role = 'backbone_admin' and p.status = 'active';
    if v_admins <= 1 then
      raise exception 'that is the last active backbone_admin; appoint another first'
        using errcode = '42501';
    end if;
  end if;

  update public.staff_profiles set role = p_role where principal_id = p_principal_id;

  perform app.audit(a, 'access.set_role', 'principal', p_principal_id::text, null,
                    jsonb_build_object('from', v_prev, 'to', p_role));

  return jsonb_build_object('principal_id', p_principal_id, 'role', p_role);
end
$$;

create or replace function public.revoke_staff(
  p_principal_id uuid,
  p_reason       text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_kind text; v_role text; v_status text; v_admins integer;
begin
  a := app.require_staff(array['backbone_admin']);

  if p_principal_id = a.principal_id then
    raise exception 'you cannot revoke yourself' using errcode = '42501';
  end if;

  select p.kind, p.status, sp.role into v_kind, v_status, v_role
    from public.principals p
    left join public.staff_profiles sp on sp.principal_id = p.id
   where p.id = p_principal_id;

  if v_kind is null then
    raise exception 'no such principal' using errcode = '23503';
  end if;
  if v_kind <> 'staff' then
    raise exception 'that principal is a partner; use revoke_partner_user'
      using errcode = '42501';
  end if;

  if v_status = 'revoked' then
    return jsonb_build_object('principal_id', p_principal_id, 'status', 'revoked',
                              'already_revoked', true);
  end if;

  -- T18. Without this, an operator-turned-admin or a mistaken admin can remove
  -- every admin, after which create_markup_version can never be called again
  -- and every pair on the board reports "no active markup" forever.
  if v_role = 'backbone_admin' then
    select count(*) into v_admins
      from public.staff_profiles sp
      join public.principals p on p.id = sp.principal_id
     where sp.role = 'backbone_admin' and p.status = 'active';
    if v_admins <= 1 then
      raise exception 'that is the last active backbone_admin; appoint another first'
        using errcode = '42501';
    end if;
  end if;

  update public.principals
     set status = 'revoked', revoked_at = now(), revoked_by = a.principal_id
   where id = p_principal_id;

  perform app.audit(a, 'access.revoke', 'principal', p_principal_id::text, null,
                    jsonb_build_object('kind', 'staff', 'role', v_role, 'reason', p_reason));

  return jsonb_build_object('principal_id', p_principal_id, 'status', 'revoked');
end
$$;

grant execute on function
  public.invite_partner_user(text, text, uuid),
  public.revoke_partner_user(uuid, text),
  public.invite_staff(text, text),
  public.set_staff_role(uuid, text),
  public.revoke_staff(uuid, text)
  to authenticated;
