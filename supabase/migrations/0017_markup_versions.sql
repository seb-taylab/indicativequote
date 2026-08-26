-- =====================================================================
-- 0017  Markup versions
-- Spec §13.2, §11.6, D3
--
-- D3: no dual approval. A backbone_admin creates an active version directly.
-- Every change is a NEW IMMUTABLE VERSION with an audit event -- nothing is
-- edited in place, so the version that priced any past quote.copy can always
-- be recovered.
--
-- The predecessor's approver-must-differ rule is deliberately not carried
-- across (A-4). If it turns out to have been a real MetaComp requirement, it
-- returns as an additive change to this table, not a rewrite.
-- =====================================================================

create or replace function public.create_markup_version(
  p_currency_pair_id uuid,
  p_default          text,
  p_min              text,
  p_max              text,
  p_reason           text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a app.actor_t; v_prev uuid; v_id uuid;
  v_default numeric; v_min numeric; v_max numeric;
begin
  a := app.require_staff(array['backbone_admin']);

  if p_reason is null or length(trim(p_reason)) = 0 then
    -- §16.3 makes the reason mandatory on the screen; enforce it at the source
    -- so the version history is never a list of unexplained numbers.
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  -- §12.7 rule 3: decimals arrive as text.
  v_default := p_default::numeric;
  v_min     := p_min::numeric;
  v_max     := p_max::numeric;

  if not exists (select 1 from public.currency_pairs where id = p_currency_pair_id) then
    raise exception 'no such currency pair' using errcode = '23503';
  end if;
  if v_min < 0 then
    raise exception 'minimum markup cannot be negative' using errcode = '22023';
  end if;
  if not (v_min <= v_default and v_default <= v_max) then
    raise exception 'the default (%) must sit inside the band (% to %)',
      v_default, v_min, v_max using errcode = '22023';
  end if;

  -- Retire the current active version and create the new one in ONE
  -- transaction, so the pair is never left with two active versions or none.
  select id into v_prev
    from public.markup_versions
   where currency_pair_id = p_currency_pair_id and status = 'active';

  if v_prev is not null then
    update public.markup_versions
       set status = 'retired', retired_at = now(), retired_by = a.principal_id
     where id = v_prev;
  end if;

  insert into public.markup_versions
    (currency_pair_id, default_bps, min_bps, max_bps, status, reason, created_by, supersedes)
  values
    (p_currency_pair_id, v_default, v_min, v_max, 'active', trim(p_reason), a.principal_id, v_prev)
  returning id into v_id;

  perform app.audit(a, 'markup.create', 'markup_version', v_id::text, null,
                    jsonb_build_object(
                      'currency_pair_id', p_currency_pair_id,
                      'default_bps', v_default::text,
                      'min_bps', v_min::text,
                      'max_bps', v_max::text,
                      'supersedes', v_prev,
                      'reason', trim(p_reason)));

  return jsonb_build_object('id', v_id, 'currency_pair_id', p_currency_pair_id,
                            'default_bps', v_default::text, 'min_bps', v_min::text,
                            'max_bps', v_max::text, 'supersedes', v_prev);
end
$$;

create or replace function public.retire_markup_version(
  p_id     uuid,
  p_reason text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v public.markup_versions;
begin
  a := app.require_staff(array['backbone_admin']);

  select * into v from public.markup_versions where id = p_id;
  if not found then
    raise exception 'no such markup version' using errcode = '23503';
  end if;
  if v.status = 'retired' then
    return jsonb_build_object('id', p_id, 'status', 'retired', 'already_retired', true);
  end if;

  update public.markup_versions
     set status = 'retired', retired_at = now(), retired_by = a.principal_id
   where id = p_id;

  -- §13.2: "Leaves the pair with no active markup; the board then withholds
  -- every row for that pair with `no active markup`." That is E9, and it is a
  -- deliberate, visible outcome rather than an error.
  perform app.audit(a, 'markup.retire', 'markup_version', p_id::text, null,
                    jsonb_build_object('currency_pair_id', v.currency_pair_id,
                                       'reason', p_reason));

  return jsonb_build_object('id', p_id, 'status', 'retired',
                            'currency_pair_id', v.currency_pair_id);
end
$$;

grant execute on function
  public.create_markup_version(uuid, text, text, text, text),
  public.retire_markup_version(uuid, text)
  to authenticated;
