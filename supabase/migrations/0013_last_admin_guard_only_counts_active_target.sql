-- =====================================================================
-- 0013  Repair: the TM5 last-admin guard refused an invited admin
--
-- The guard in 0012 tested the count of ACTIVE backbone_admins without
-- checking whether the TARGET was active. Revoking or demoting an *invited*
-- backbone_admin -- one who has never signed in -- does not reduce the active
-- admin count, but was refused, with the message "that is the last active
-- backbone_admin" about a principal that is not active at all.
--
-- Observed before the fix:
--   target newadmin status / role            -> invited / backbone_admin
--   revoke an INVITED admin                  -> REFUSED (wrong)
--   demote an INVITED admin                  -> REFUSED (wrong)
--
-- Effect: an admin who mistypes an address while inviting a colleague as
-- backbone_admin cannot withdraw the invitation until a second admin has been
-- appointed AND has signed in.
--
-- NOTE ON WHAT ACTUALLY ENFORCES T18.
-- With the target-active condition added, this guard is unreachable for a
-- non-self target: require_staff() admits only an ACTIVE backbone_admin, so if
-- the target is a different active admin the count is necessarily >= 2. What
-- makes "the last active backbone_admin cannot be revoked" true is the
-- SELF-revocation refusal directly above it. The count guard is kept as
-- defence in depth -- it becomes load-bearing the moment anyone relaxes the
-- self check or widens who may call revoke_staff, which is exactly when a
-- reviewer would otherwise not notice.
-- =====================================================================

create or replace function public.set_staff_role(p_principal_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a app.actor_t; v_prev text; v_status text; v_admins integer;
begin
  a := app.require_staff(array['backbone_admin']);
  if p_role not in ('rm_viewer','backbone_operator','backbone_admin') then
    raise exception 'role must be rm_viewer, backbone_operator or backbone_admin' using errcode = '22023';
  end if;
  if p_principal_id = a.principal_id then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  select sp.role, p.status into v_prev, v_status
    from public.staff_profiles sp
    join public.principals p on p.id = sp.principal_id
   where sp.principal_id = p_principal_id;
  if v_prev is null then
    raise exception 'no such staff principal' using errcode = '23503';
  end if;
  if v_prev = 'backbone_admin' and p_role <> 'backbone_admin' and v_status = 'active' then
    select count(*) into v_admins from public.staff_profiles sp
      join public.principals p on p.id = sp.principal_id
     where sp.role='backbone_admin' and p.status='active';
    if v_admins <= 1 then
      raise exception 'that is the last active backbone_admin; appoint another first' using errcode = '42501';
    end if;
  end if;
  update public.staff_profiles set role = p_role where principal_id = p_principal_id;
  perform app.audit(a, 'access.set_role', 'principal', p_principal_id::text, null,
                    jsonb_build_object('from',v_prev,'to',p_role));
  return jsonb_build_object('principal_id',p_principal_id,'role',p_role);
end $$;

create or replace function public.revoke_staff(p_principal_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
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
    raise exception 'that principal is a partner; use revoke_partner_user' using errcode = '42501';
  end if;
  if v_status = 'revoked' then
    return jsonb_build_object('principal_id',p_principal_id,'status','revoked','already_revoked',true);
  end if;
  if v_role = 'backbone_admin' and v_status = 'active' then
    select count(*) into v_admins from public.staff_profiles sp
      join public.principals p on p.id = sp.principal_id
     where sp.role='backbone_admin' and p.status='active';
    if v_admins <= 1 then
      raise exception 'that is the last active backbone_admin; appoint another first' using errcode = '42501';
    end if;
  end if;
  update public.principals
     set status='revoked', revoked_at=now(), revoked_by=a.principal_id
   where id = p_principal_id;
  perform app.audit(a, 'access.revoke', 'principal', p_principal_id::text, null,
                    jsonb_build_object('kind','staff','role',v_role,'reason',p_reason));
  return jsonb_build_object('principal_id',p_principal_id,'status','revoked');
end $$;
