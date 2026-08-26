-- =====================================================================
-- 0021  Sign-in: binding an auth user to a principal
-- Spec §19, §11.7. See docs/spec-findings.md F11.
--
-- §19: "On first click, auth_user_id and first_seen_at are set." §11.7 lists
-- access.signin and access.signin_denied as audited actions. But §13 -- "the
-- complete write surface" -- contains no operation that does either, and D2
-- means principals accepts no direct UPDATE from any application role.
--
-- So as specified, a principal can be invited and can never sign in.
--
-- These two functions close that. Neither is granted to `authenticated`:
-- they are called from the server-side auth route with the service-role key,
-- which is the only context where the caller is not yet a principal. The
-- 0007 event trigger has already revoked PUBLIC and anon.
--
-- TM12, e-mail enumeration: sign_in_allowed returns only a boolean and writes
-- the denial audit itself, so the calling route can respond identically
-- whether or not the address is known. The route must not branch on it in a
-- way a caller can observe.
-- =====================================================================

-- Called BEFORE a magic link is sent. Returns true only for a principal that
-- may sign in. Records the denial when it returns false.
create or replace function public.sign_in_allowed(p_email text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid; v_status text;
begin
  select p.id, p.status into v_id, v_status
    from public.principals p
   where lower(p.email::text) = lower(trim(p_email));

  if v_id is null or v_status = 'revoked' then
    -- §18.4: structured keys only. The address IS the subject of this record,
    -- so it belongs in subject_id, where a deletion request can find it --
    -- not buried in a rendered sentence.
    insert into public.audit_events (action, subject_type, subject_id, detail)
    values ('access.signin_denied', 'email', lower(trim(p_email)),
            jsonb_build_object('reason',
              case when v_id is null then 'unknown' else 'revoked' end));
    return false;
  end if;

  return true;
end
$$;

-- Called AFTER the magic link is verified, with the new auth user id.
-- Binds the auth user to the principal, stamps first/last seen, and promotes
-- an `invited` principal to `active`.
create or replace function public.record_sign_in(
  p_auth_user_id uuid,
  p_email        text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare p public.principals; v_first boolean;
begin
  select * into p from public.principals
   where lower(email::text) = lower(trim(p_email));

  if not found or p.status = 'revoked' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- An auth user id already bound to a DIFFERENT principal would mean two
  -- principals share a login. The unique index on auth_user_id refuses it;
  -- this raises the readable error first.
  if p.auth_user_id is not null and p.auth_user_id <> p_auth_user_id then
    raise exception 'that principal is already bound to another login'
      using errcode = '42501';
  end if;

  v_first := p.first_seen_at is null;

  update public.principals
     set auth_user_id  = p_auth_user_id,
         first_seen_at = coalesce(first_seen_at, now()),
         last_seen_at  = now(),
         -- §19: the invitation is accepted by using it.
         status        = case when status = 'invited' then 'active' else status end
   where id = p.id;

  insert into public.audit_events
    (actor_id, actor_email, action, subject_type, subject_id, partner_id, detail)
  select p.id, p.email, 'access.signin', 'principal', p.id::text, pm.partner_id,
         jsonb_build_object('first_sign_in', v_first, 'kind', p.kind)
    from public.principals pr
    left join public.partner_memberships pm on pm.principal_id = pr.id
   where pr.id = p.id;

  return jsonb_build_object('principal_id', p.id, 'kind', p.kind,
                            'first_sign_in', v_first);
end
$$;

-- Deliberately NOT granted to authenticated. Server-side only, service role.
revoke execute on function
  public.sign_in_allowed(text), public.record_sign_in(uuid, text)
  from public, anon, authenticated;
