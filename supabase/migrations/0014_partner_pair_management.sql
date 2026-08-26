-- =====================================================================
-- 0014  Partner pair management
-- Spec §13.1
--
-- partner_admin only, own partner only. The tenant boundary is always the
-- caller's own partner_id from app.require_partner() -- never a partner_id
-- supplied by the client, which is the shape of every cross-tenant bug.
-- =====================================================================

create or replace function public.add_partner_pair(p_currency_pair_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_id uuid; v_base text; v_quote text;
begin
  a := app.require_partner(array['partner_admin']);

  select cp.base_ccy, cp.quote_ccy into v_base, v_quote
    from public.currency_pairs cp
   where cp.id = p_currency_pair_id and cp.active;
  if not found then
    raise exception 'that pair is not in the canonical registry, or is inactive'
      using errcode = '23503';
  end if;

  -- Re-adding a pair the partner previously deactivated reactivates it rather
  -- than failing on the unique constraint. §6.3 warning 3 offers exactly this.
  insert into public.partner_pairs (partner_id, currency_pair_id, added_by)
  values (a.partner_id, p_currency_pair_id, a.principal_id)
  on conflict (partner_id, currency_pair_id) do update
     set active = true, deactivated_at = null, deactivated_by = null
  returning id into v_id;

  perform app.audit(a, 'pair.add', 'partner_pair', v_id::text, a.partner_id,
                    jsonb_build_object('currency_pair_id', p_currency_pair_id,
                                       'base_ccy', v_base, 'quote_ccy', v_quote));

  return jsonb_build_object('id', v_id, 'base_ccy', v_base, 'quote_ccy', v_quote,
                            'active', true);
end
$$;

create or replace function public.set_partner_pair_active(
  p_partner_pair_id uuid,
  p_active          boolean
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_owner uuid;
begin
  a := app.require_partner(array['partner_admin']);

  select partner_id into v_owner from public.partner_pairs where id = p_partner_pair_id;
  if v_owner is null then
    raise exception 'no such partner pair' using errcode = '23503';
  end if;
  -- Tenant check. The composite FK protects `rates`, but partner_pairs itself
  -- is addressed by id here, so the ownership test has to be explicit.
  if v_owner <> a.partner_id then
    raise exception 'that pair belongs to another partner' using errcode = '42501';
  end if;

  update public.partner_pairs
     set active         = p_active,
         deactivated_at = case when p_active then null else now() end,
         deactivated_by = case when p_active then null else a.principal_id end
   where id = p_partner_pair_id;

  -- Deactivating does not withdraw or supersede the pair's rates. They remain
  -- current rows, and E3 makes them ineligible while the pair is inactive --
  -- so reactivating restores exactly what was there, subject to validity (D5).
  -- 'pair.reactivate' rather than reusing 'pair.add': §11.7's list is a
  -- minimum, and an audit trail that records a reactivation as an addition
  -- loses the distinction a reviewer is looking for.
  perform app.audit(a, case when p_active then 'pair.reactivate' else 'pair.deactivate' end,
                    'partner_pair', p_partner_pair_id::text, a.partner_id,
                    jsonb_build_object('active', p_active));

  return jsonb_build_object('id', p_partner_pair_id, 'active', p_active);
end
$$;

create or replace function public.set_partner_pair_quote_mode(
  p_partner_pair_id uuid,
  p_mode            text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_owner uuid; v_prev text;
begin
  a := app.require_partner(array['partner_admin']);

  if p_mode not in ('two_way','bid_only','ask_only','either_side') then
    raise exception 'mode must be two_way, bid_only, ask_only or either_side'
      using errcode = '22023';
  end if;

  select partner_id, quote_mode into v_owner, v_prev
    from public.partner_pairs where id = p_partner_pair_id;
  if v_owner is null then
    raise exception 'no such partner pair' using errcode = '23503';
  end if;
  if v_owner <> a.partner_id then
    raise exception 'that pair belongs to another partner' using errcode = '42501';
  end if;

  update public.partner_pairs set quote_mode = p_mode where id = p_partner_pair_id;

  -- Tightening the mode does not invalidate rates already stored under the
  -- looser one. E6 withholds a row whose needed side is absent, with a reason,
  -- rather than the row vanishing.
  perform app.audit(a, 'pair.set_mode', 'partner_pair', p_partner_pair_id::text, a.partner_id,
                    jsonb_build_object('from', v_prev, 'to', p_mode));

  return jsonb_build_object('id', p_partner_pair_id, 'quote_mode', p_mode);
end
$$;

grant execute on function
  public.add_partner_pair(uuid),
  public.set_partner_pair_active(uuid, boolean),
  public.set_partner_pair_quote_mode(uuid, text)
  to authenticated;
