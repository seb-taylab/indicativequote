-- =====================================================================
-- 0009  Registry and partner administration
-- Spec §13.2, step 2 of §21.1
--
-- Every function here is SECURITY DEFINER with an empty search_path, resolves
-- the caller through app.require_staff(), and writes its audit event in the
-- same transaction as its effect.
--
-- §12.7 rule 3: every RPC accepting a decimal accepts it as `text` and casts
-- server-side, so a malformed value is a database error rather than a silent
-- rounding. Integers (TTL minutes) are not decimals and pass as integers.
-- =====================================================================

-- --- Currencies -------------------------------------------------------
-- ADDITIVE TO THE SPEC. §13.2 gives `register_currency_pair` but no way to
-- add a currency, and currency_pairs has a foreign key to currencies -- so as
-- specified the registry can never admit a currency it was not seeded with.
-- See docs/spec-findings.md F6. Same role and audit shape as its sibling.
-- p_minor_units is `integer`, not `smallint`, deliberately. A caller passing
-- the literal 2 sends an integer, and Postgres will not implicitly narrow it
-- during function resolution -- the call fails with "function does not exist",
-- which reads like a deployment fault rather than a type mismatch. Every
-- parameter on the RPC boundary takes the widest natural type and narrows
-- inside.
create or replace function public.register_currency(
  p_code        text,
  p_name        text,
  p_kind        text,
  p_minor_units integer default 2
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_code text;
begin
  a := app.require_staff(array['backbone_admin']);
  v_code := upper(trim(p_code));

  if p_kind not in ('fiat','stablecoin') then
    raise exception 'kind must be fiat or stablecoin' using errcode = '22023';
  end if;

  insert into public.currencies (code, name, kind, minor_units)
  values (v_code, p_name, p_kind, p_minor_units::smallint)
  on conflict (code) do nothing;

  if not found then
    raise exception 'currency % already registered', v_code using errcode = '23505';
  end if;

  perform app.audit(a, 'registry.add_currency', 'currency', v_code, null,
                    jsonb_build_object('code', v_code, 'kind', p_kind));
  return jsonb_build_object('code', v_code);
end
$$;

-- --- Currency pairs ---------------------------------------------------
-- D8: one approved orientation per couple, a curated human decision. Refuses
-- when the couple already exists in EITHER orientation -- the
-- currency_pairs_no_inverse index enforces it, and this raises the readable
-- error rather than letting a constraint violation reach the client.
create or replace function public.register_currency_pair(
  p_base  text,
  p_quote text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a        app.actor_t;
  v_base   text := upper(trim(p_base));
  v_quote  text := upper(trim(p_quote));
  v_id     uuid;
  v_exists record;
begin
  a := app.require_staff(array['backbone_admin']);

  if v_base = v_quote then
    raise exception 'base and quote must differ' using errcode = '22023';
  end if;

  select cp.id, cp.base_ccy, cp.quote_ccy into v_exists
    from public.currency_pairs cp
   where least(cp.base_ccy, cp.quote_ccy)    = least(v_base, v_quote)
     and greatest(cp.base_ccy, cp.quote_ccy) = greatest(v_base, v_quote);

  if found then
    raise exception 'couple %/% is already registered as %/%',
      v_base, v_quote, v_exists.base_ccy, v_exists.quote_ccy
      using errcode = '23505';
  end if;

  insert into public.currency_pairs (base_ccy, quote_ccy)
  values (v_base, v_quote)
  returning id into v_id;

  perform app.audit(a, 'registry.add_pair', 'currency_pair', v_id::text, null,
                    jsonb_build_object('base_ccy', v_base, 'quote_ccy', v_quote));

  return jsonb_build_object('id', v_id, 'base_ccy', v_base, 'quote_ccy', v_quote);
end
$$;

-- --- Partners ---------------------------------------------------------
create or replace function public.create_partner(
  p_slug             text,
  p_display_name     text,
  p_soft_ttl_minutes integer default 120,
  p_hard_ttl_minutes integer default 480,
  p_move_warn_pct    text    default '5.000'
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_id uuid; v_move numeric;
begin
  a := app.require_staff(array['backbone_admin']);

  v_move := p_move_warn_pct::numeric;   -- §12.7: malformed input is an error here

  if p_hard_ttl_minutes < p_soft_ttl_minutes then
    raise exception 'hard TTL must be at least the soft TTL' using errcode = '22023';
  end if;

  insert into public.partners
    (slug, display_name, soft_ttl_minutes, hard_ttl_minutes, move_warn_pct, created_by)
  values
    (trim(p_slug)::extensions.citext, p_display_name,
     p_soft_ttl_minutes, p_hard_ttl_minutes, v_move, a.principal_id)
  returning id into v_id;

  perform app.audit(a, 'partner.create', 'partner', v_id::text, v_id,
                    jsonb_build_object(
                      'slug', trim(p_slug),
                      'soft_ttl_minutes', p_soft_ttl_minutes,
                      'hard_ttl_minutes', p_hard_ttl_minutes,
                      'move_warn_pct', v_move::text));

  -- A partner is created WITHOUT its convention confirmed. Its rates can be
  -- submitted and stored, and show as unavailable, until an admin confirms
  -- [A-1] in writing. §11.2, §1.5.
  return jsonb_build_object(
    'id', v_id,
    'slug', trim(p_slug),
    'convention_confirmed', false);
end
$$;

create or replace function public.set_partner_status(
  p_partner_id uuid,
  p_status     text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_prev text;
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  if p_status not in ('active','inactive') then
    raise exception 'status must be active or inactive' using errcode = '22023';
  end if;

  select status into v_prev from public.partners where id = p_partner_id;
  if v_prev is null then
    raise exception 'no such partner' using errcode = '23503';
  end if;

  update public.partners set status = p_status where id = p_partner_id;

  -- Deactivation makes every rate ineligible immediately (E1). Reactivation
  -- does not resurrect expired rates, because validity is stamped (D5).
  --
  -- §11.7 lists partner.deactivate as a minimum, not an exhaustive set. An
  -- audit trail that records a reactivation as a deactivation is worse than
  -- one that names an action the spec did not enumerate.
  perform app.audit(a,
                    case when p_status = 'inactive' then 'partner.deactivate'
                         else 'partner.activate' end,
                    'partner', p_partner_id::text, p_partner_id,
                    jsonb_build_object('from', v_prev, 'to', p_status));

  return jsonb_build_object('id', p_partner_id, 'status', p_status);
end
$$;

create or replace function public.set_partner_policy(
  p_partner_id       uuid,
  p_soft_ttl_minutes integer,
  p_hard_ttl_minutes integer,
  p_move_warn_pct    text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_move numeric; v_prev record;
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  v_move := p_move_warn_pct::numeric;

  if p_soft_ttl_minutes <= 0 or p_hard_ttl_minutes <= 0 then
    raise exception 'TTLs must be positive' using errcode = '22023';
  end if;
  if p_hard_ttl_minutes < p_soft_ttl_minutes then
    raise exception 'hard TTL must be at least the soft TTL' using errcode = '22023';
  end if;

  select soft_ttl_minutes, hard_ttl_minutes, move_warn_pct into v_prev
    from public.partners where id = p_partner_id;
  if not found then
    raise exception 'no such partner' using errcode = '23503';
  end if;

  update public.partners
     set soft_ttl_minutes = p_soft_ttl_minutes,
         hard_ttl_minutes = p_hard_ttl_minutes,
         move_warn_pct    = v_move
   where id = p_partner_id;

  -- D5: a policy change affects FUTURE submissions only. Every stored rate
  -- keeps the stamps it was written with; history is never reinterpreted.
  perform app.audit(a, 'partner.set_policy', 'partner', p_partner_id::text, p_partner_id,
                    jsonb_build_object(
                      'from', jsonb_build_object(
                        'soft_ttl_minutes', v_prev.soft_ttl_minutes,
                        'hard_ttl_minutes', v_prev.hard_ttl_minutes,
                        'move_warn_pct', v_prev.move_warn_pct::text),
                      'to', jsonb_build_object(
                        'soft_ttl_minutes', p_soft_ttl_minutes,
                        'hard_ttl_minutes', p_hard_ttl_minutes,
                        'move_warn_pct', v_move::text)));

  return jsonb_build_object(
    'id', p_partner_id,
    'soft_ttl_minutes', p_soft_ttl_minutes,
    'hard_ttl_minutes', p_hard_ttl_minutes,
    'move_warn_pct', v_move::text);
end
$$;

-- The [A-1] gate. Until this is called, the partner's rates are stored but
-- never usable on the board. §1.5: no partner reaches the board until the
-- bid/ask convention is confirmed IN WRITING -- p_ref records where.
create or replace function public.confirm_partner_convention(
  p_partner_id uuid,
  p_ref        text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_already timestamptz;
begin
  a := app.require_staff(array['backbone_admin']);

  if p_ref is null or length(trim(p_ref)) = 0 then
    raise exception 'a written confirmation reference is required'
      using errcode = '22023';
  end if;

  select convention_confirmed_at into v_already
    from public.partners where id = p_partner_id;
  if not found then
    raise exception 'no such partner' using errcode = '23503';
  end if;

  update public.partners
     set convention_confirmed_at = now(),
         convention_confirmed_by = a.principal_id,
         convention_ref          = trim(p_ref)
   where id = p_partner_id;

  perform app.audit(a, 'partner.confirm_convention', 'partner', p_partner_id::text, p_partner_id,
                    jsonb_build_object('ref', trim(p_ref),
                                       'previously_confirmed', v_already is not null));

  return jsonb_build_object('id', p_partner_id, 'convention_confirmed', true);
end
$$;

-- --- Grants -----------------------------------------------------------
-- Explicit and per-function. The role check inside each function is the
-- authorisation; this grant only makes the function reachable (§13).
grant execute on function
  public.register_currency(text, text, text, integer),
  public.register_currency_pair(text, text),
  public.create_partner(text, text, integer, integer, text),
  public.set_partner_status(uuid, text),
  public.set_partner_policy(uuid, integer, integer, text),
  public.confirm_partner_convention(uuid, text)
  to authenticated;
