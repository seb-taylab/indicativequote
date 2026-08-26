-- =====================================================================
-- 0022  Readable eligibility reasons
-- Spec §14, §7
--
-- RECONSTRUCTED FROM THE LIVE DATABASE. This change was applied directly and
-- went without a migration file for a period. §18.1 calls that an incident,
-- and it is one: a rebuild from files alone would produce a board whose
-- withheld reasons read "outside size range, 0.000000 to 100000.000000",
-- making the reader decode numeric(24,6)'s storage scale to learn that the
-- band is 0 to 100,000. The reason line is prose for a person, so it is
-- formatted like prose.
--
-- app.fmt_num trims the TEXT, never by casting through a float, and only where
-- a decimal point exists -- so '100' can never become '1'.
-- =====================================================================

CREATE OR REPLACE FUNCTION app.fmt_num(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
           when p is null then null
           when position('.' in p::text) > 0
             then rtrim(rtrim(p::text, '0'), '.')
           else p::text
         end
$function$
;

revoke execute on function app.fmt_num(numeric) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.board_rates(p_currency_pair_id uuid, p_direction text, p_amount text DEFAULT NULL::text, p_markup_bps text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a app.actor_t; v_amount numeric; v_markup numeric;
  v_mv public.markup_versions; v_pair public.currency_pairs; v_side text;
  v_eligible jsonb := '[]'::jsonb; v_inelig jsonb := '[]'::jsonb;
  v_rankable boolean; c record;
begin
  a := app.require_staff(array['rm_viewer','backbone_operator','backbone_admin']);
  v_side := app.side_for_direction(p_direction);
  if v_side is null then
    raise exception 'direction must be client_sells_base or client_buys_base' using errcode='22023';
  end if;
  select * into v_pair from public.currency_pairs where id = p_currency_pair_id;
  if not found then raise exception 'no such currency pair' using errcode='23503'; end if;

  v_amount := nullif(trim(coalesce(p_amount,'')),'')::numeric;
  if v_amount is not null and v_amount <= 0 then
    raise exception 'amount must be positive' using errcode='22023';
  end if;

  select * into v_mv from public.markup_versions
   where currency_pair_id = p_currency_pair_id and status='active';

  if v_mv.id is null then
    v_markup := null;
  else
    v_markup := coalesce(nullif(trim(coalesce(p_markup_bps,'')),'')::numeric, v_mv.default_bps);
    if v_markup < v_mv.min_bps or v_markup > v_mv.max_bps then
      raise exception 'markup % bps is outside the active band for this pair (% to %)',
        app.fmt_num(v_markup), app.fmt_num(v_mv.min_bps), app.fmt_num(v_mv.max_bps) using errcode='22023';
    end if;
  end if;

  for c in
    select r.id, r.partner_id, r.partner_bid, r.partner_ask,
           r.size_status, r.min_size, r.max_size,
           r.observed_at, r.submitted_at, r.valid_until, r.expiry_warning_at,
           r.normalised_from_inverse, r.correction_of,
           p.display_name as partner_name, p.slug as partner_slug,
           p.status as partner_status, p.convention_confirmed_at,
           pp.active as pair_active, pp.quote_mode,
           case when r.partner_bid is null and v_side='bid' then false
                when r.partner_ask is null and v_side='ask' then false
                else true end as has_side
      from public.rates r
      join public.partners p on p.id = r.partner_id
      join public.partner_pairs pp on pp.id = r.partner_pair_id
     where pp.currency_pair_id = p_currency_pair_id
       and r.superseded_by is null and r.withdrawn_at is null
  loop
    declare
      v_reason text := null; v_show boolean := true; v_rate numeric; v_row jsonb;
    begin
      if c.partner_status <> 'active' then
        v_reason := 'partner inactive'; v_show := false;
      elsif c.convention_confirmed_at is null then
        v_reason := 'convention not confirmed'; v_show := false;
      elsif not c.pair_active then
        v_reason := 'pair not offered'; v_show := false;
      elsif not c.has_side then
        v_reason := 'partner quotes one side only';
      elsif now() >= c.valid_until then
        v_reason := 'expired, valid until '
                    || to_char(c.valid_until at time zone 'Asia/Singapore','HH24:MI') || ' SGT';
      elsif v_amount is not null and c.size_status = 'unconfirmed' then
        v_reason := 'size not confirmed by partner';
      elsif v_amount is not null and c.size_status = 'confirmed'
            and not (v_amount >= c.min_size and (c.max_size is null or v_amount <= c.max_size)) then
        v_reason := 'outside size range, ' || app.fmt_num(c.min_size) || ' to '
                    || coalesce(app.fmt_num(c.max_size), 'no ceiling');
      elsif v_mv.id is null then
        v_reason := 'no active markup';
      end if;

      if v_reason is not null and not v_show then continue; end if;

      if v_reason is null then
        v_rate := app.client_rate(c.partner_bid, c.partner_ask, p_direction, v_markup);
      end if;

      v_row := jsonb_build_object(
        'rate_id', c.id, 'partner_name', c.partner_name, 'partner_slug', c.partner_slug,
        'partner_bid', c.partner_bid::text, 'partner_ask', c.partner_ask::text,
        'spread', case when c.partner_bid is not null and c.partner_ask is not null
                       then (c.partner_ask - c.partner_bid)::text end,
        'size_status', c.size_status, 'min_size', c.min_size::text, 'max_size', c.max_size::text,
        'observed_at', c.observed_at, 'submitted_at', c.submitted_at, 'valid_until', c.valid_until,
        'status', case when now() >= c.valid_until then 'expired'
                       when now() >= c.expiry_warning_at then 'expiring' else 'live' end,
        'source', case when c.normalised_from_inverse then 'normalised'
                       when c.correction_of is not null then 'correction' else 'submitted' end,
        'markup_bps', v_markup::text, 'client_rate', v_rate::text,
        'counter_amount', case when v_rate is not null and v_amount is not null
                               then round(v_amount * v_rate, 2)::text end);

      if v_reason is null then v_eligible := v_eligible || v_row;
      else v_inelig := v_inelig || (v_row || jsonb_build_object('reason', v_reason));
      end if;
    end;
  end loop;

  v_rankable := v_mv.id is not null;

  if v_rankable and jsonb_array_length(v_eligible) > 0 then
    select jsonb_agg(rw order by ord) into v_eligible
      from (
        select e.value || jsonb_build_object('rank', row_number() over (
                 order by case when p_direction='client_sells_base'
                               then -(e.value->>'client_rate')::numeric
                               else  (e.value->>'client_rate')::numeric end asc,
                          (e.value->>'observed_at')::timestamptz desc,
                          ((e.value->>'max_size') is null) desc,
                          ((e.value->>'max_size')::numeric - (e.value->>'min_size')::numeric) desc nulls last,
                          e.value->>'partner_name' asc)) as rw,
               row_number() over (
                 order by case when p_direction='client_sells_base'
                               then -(e.value->>'client_rate')::numeric
                               else  (e.value->>'client_rate')::numeric end asc,
                          (e.value->>'observed_at')::timestamptz desc,
                          ((e.value->>'max_size') is null) desc,
                          ((e.value->>'max_size')::numeric - (e.value->>'min_size')::numeric) desc nulls last,
                          e.value->>'partner_name' asc) as ord
          from jsonb_array_elements(v_eligible) e
      ) ranked;
  end if;

  return jsonb_build_object(
    'currency_pair', jsonb_build_object('id', v_pair.id, 'base_ccy', v_pair.base_ccy,
                                        'quote_ccy', v_pair.quote_ccy),
    'direction', p_direction, 'side_used', v_side, 'amount', v_amount::text,
    'amount_header', case when p_direction='client_sells_base'
                          then v_pair.quote_ccy || ' received'
                          else v_pair.quote_ccy || ' paid' end,
    'markup_bps', v_markup::text,
    'markup_version', case when v_mv.id is null then null else jsonb_build_object(
        'id', v_mv.id, 'default_bps', v_mv.default_bps::text,
        'min_bps', v_mv.min_bps::text, 'max_bps', v_mv.max_bps::text) end,
    'rankable', v_rankable,
    'eligible', coalesce(v_eligible,'[]'::jsonb),
    'ineligible', v_inelig,
    'withheld_count', jsonb_array_length(v_inelig));
end
$function$
;
