-- =====================================================================
-- 0016  The board and the copied quote
-- Spec §7, §8, §14, §15
--
-- board_rates is "the only path that joins rates to markup", and it is
-- staff-only. record_quote_copy recomputes the price server-side and returns
-- finished text; it accepts no price from the caller.
--
-- §10.2 THE MAPPING LIVES IN app.side_for_direction AND NOWHERE ELSE.
-- The TypeScript in src/domain/rates.ts carries the same rule for display, and
-- tests/unit asserts the two agree. Authority is here, because §8 is explicit
-- that a price the browser supplies is "whatever the browser said it was, and
-- a bug or a tampered request writes a false pricing record that looks
-- authoritative forever".
-- =====================================================================

-- §10.2. The one function. Never re-derive this anywhere else.
create or replace function app.side_for_direction(p_direction text)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_direction
           when 'client_sells_base' then 'bid'   -- client gives BASE, receives QUOTE
           when 'client_buys_base'  then 'ask'   -- client gives QUOTE, receives BASE
         end
$$;

-- §15.1. Markup WIDENS the spread: both sides move away from the partner
-- price. A single directional addition makes roughly half of all quotes wrong
-- in the client's favour.
create or replace function app.client_rate(
  p_bid numeric, p_ask numeric, p_direction text, p_markup_bps numeric
) returns numeric
language sql immutable
set search_path = ''
as $$
  select case app.side_for_direction(p_direction)
           when 'bid' then p_bid * (1 - p_markup_bps / 10000)
           when 'ask' then p_ask * (1 + p_markup_bps / 10000)
         end
$$;

revoke execute on function
  app.side_for_direction(text), app.client_rate(numeric, numeric, text, numeric)
  from public, anon, authenticated;

-- --- §7, §14, §15: the board -----------------------------------------
create or replace function public.board_rates(
  p_currency_pair_id uuid,
  p_direction        text,
  p_amount           text default null,
  p_markup_bps       text default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a          app.actor_t;
  v_amount   numeric;
  v_markup   numeric;
  v_mv       public.markup_versions;
  v_pair     public.currency_pairs;
  v_side     text;
  v_eligible jsonb := '[]'::jsonb;
  v_inelig   jsonb := '[]'::jsonb;
  v_rank     integer := 0;
  v_rankable boolean;
  c          record;
begin
  a := app.require_staff(array['rm_viewer','backbone_operator','backbone_admin']);

  if app.side_for_direction(p_direction) is null then
    raise exception 'direction must be client_sells_base or client_buys_base'
      using errcode = '22023';
  end if;
  v_side := app.side_for_direction(p_direction);

  select * into v_pair from public.currency_pairs where id = p_currency_pair_id;
  if not found then
    raise exception 'no such currency pair' using errcode = '23503';
  end if;

  -- §12.7 rule 3: the amount an RM types is the one number that enters as
  -- user text. Validated as a decimal here, not coerced.
  v_amount := nullif(trim(coalesce(p_amount, '')), '')::numeric;
  if v_amount is not null and v_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;

  -- E9's input. A pair with no active markup version can quote nothing.
  select * into v_mv
    from public.markup_versions
   where currency_pair_id = p_currency_pair_id and status = 'active';

  if v_mv.id is null then
    v_markup := null;
  else
    v_markup := coalesce(nullif(trim(coalesce(p_markup_bps, '')), '')::numeric, v_mv.default_bps);
    -- §15.1: "rejected by board_rates unless min_bps <= m <= max_bps".
    if v_markup < v_mv.min_bps or v_markup > v_mv.max_bps then
      raise exception 'markup % bps is outside the active band for this pair (% to %)',
        v_markup, v_mv.min_bps, v_mv.max_bps using errcode = '22023';
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
           case when r.partner_bid is null and v_side = 'bid' then false
                when r.partner_ask is null and v_side = 'ask' then false
                else true end as has_side
      from public.rates r
      join public.partners      p  on p.id  = r.partner_id
      join public.partner_pairs pp on pp.id = r.partner_pair_id
     where pp.currency_pair_id = p_currency_pair_id
       and r.superseded_by is null          -- E5
       and r.withdrawn_at  is null          -- E4
  loop
    declare
      v_reason text := null;
      v_show   boolean := true;   -- E1..E5 failures are not rendered at all
      v_rate   numeric;
      v_row    jsonb;
    begin
      -- Gates in the order §14 states. The first failure wins, so a row that
      -- fails several reports the earliest reason -- which is the one that
      -- has to be fixed first.
      if c.partner_status <> 'active' then
        v_reason := 'partner inactive';           v_show := false;   -- E1
      elsif c.convention_confirmed_at is null then
        v_reason := 'convention not confirmed';   v_show := false;   -- E2
      elsif not c.pair_active then
        v_reason := 'pair not offered';           v_show := false;   -- E3
      elsif not c.has_side then
        v_reason := 'partner quotes one side only';                  -- E6
      elsif now() >= c.valid_until then
        v_reason := 'expired, valid until '
                    || to_char(c.valid_until at time zone 'Asia/Singapore', 'HH24:MI') || ' SGT'; -- E7
      elsif v_amount is not null and c.size_status = 'unconfirmed' then
        v_reason := 'size not confirmed by partner';                 -- E8
      elsif v_amount is not null and c.size_status = 'confirmed'
            and not (v_amount >= c.min_size
                     and (c.max_size is null or v_amount <= c.max_size)) then
        v_reason := 'outside size range, ' || c.min_size::text || ' to '
                    || coalesce(c.max_size::text, 'no ceiling');     -- E8
      elsif v_mv.id is null then
        v_reason := 'no active markup';                              -- E9
      end if;

      if v_reason is not null and not v_show then
        continue;   -- E1..E5: not rendered
      end if;

      if v_reason is null then
        v_rate := app.client_rate(c.partner_bid, c.partner_ask, p_direction, v_markup);
      end if;

      -- §12.7 rule 1: every decimal leaves as text.
      v_row := jsonb_build_object(
        'rate_id',        c.id,
        'partner_name',   c.partner_name,
        'partner_slug',   c.partner_slug,
        'partner_bid',    c.partner_bid::text,
        'partner_ask',    c.partner_ask::text,
        'spread',         case when c.partner_bid is not null and c.partner_ask is not null
                               then (c.partner_ask - c.partner_bid)::text end,
        'size_status',    c.size_status,
        'min_size',       c.min_size::text,
        'max_size',       c.max_size::text,
        'observed_at',    c.observed_at,
        'submitted_at',   c.submitted_at,
        'valid_until',    c.valid_until,
        'status',         case
                            when now() >= c.valid_until          then 'expired'
                            when now() >= c.expiry_warning_at    then 'expiring'
                            else 'live' end,
        'source',         case when c.normalised_from_inverse then 'normalised'
                               when c.correction_of is not null then 'correction'
                               else 'submitted' end,
        'markup_bps',     v_markup::text,
        'client_rate',    v_rate::text,
        'counter_amount', case when v_rate is not null and v_amount is not null
                               then round(v_amount * v_rate, 2)::text end);

      if v_reason is null then
        v_eligible := v_eligible || v_row;
      else
        v_inelig := v_inelig || (v_row || jsonb_build_object('reason', v_reason));
      end if;
    end;
  end loop;

  -- §15.2 rule 5: if ranking inputs are missing, rows render unranked and
  -- labelled. "A rank badge on an unordered list is a false winner and MUST
  -- NOT be rendered."
  v_rankable := v_mv.id is not null;

  if v_rankable and jsonb_array_length(v_eligible) > 0 then
    -- Rule 2: sort direction depends on side. Rule 4: ties break by newer
    -- observed_at, then wider band, then partner name -- deterministic and
    -- reproducible.
    select jsonb_agg(row_with_rank order by ord)
      into v_eligible
      from (
        select e.value || jsonb_build_object('rank', row_number() over (
                 order by
                   case when p_direction = 'client_sells_base'
                        then -(e.value->>'client_rate')::numeric
                        else  (e.value->>'client_rate')::numeric end asc,
                   (e.value->>'observed_at')::timestamptz desc,
                   ((e.value->>'max_size') is null) desc,
                   ((e.value->>'max_size')::numeric - (e.value->>'min_size')::numeric) desc nulls last,
                   e.value->>'partner_name' asc)) as row_with_rank,
               row_number() over (
                 order by
                   case when p_direction = 'client_sells_base'
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
    'currency_pair', jsonb_build_object('id', v_pair.id,
                       'base_ccy', v_pair.base_ccy, 'quote_ccy', v_pair.quote_ccy),
    'direction',     p_direction,
    'side_used',     v_side,
    'amount',        v_amount::text,
    -- §7: the header changes with the direction, because the client's
    -- position changes with it.
    'amount_header', case when p_direction = 'client_sells_base'
                          then v_pair.quote_ccy || ' received'
                          else v_pair.quote_ccy || ' paid' end,
    'markup_bps',    v_markup::text,
    'markup_version', case when v_mv.id is null then null else jsonb_build_object(
                        'id', v_mv.id, 'default_bps', v_mv.default_bps::text,
                        'min_bps', v_mv.min_bps::text, 'max_bps', v_mv.max_bps::text) end,
    'rankable',      v_rankable,
    'eligible',      coalesce(v_eligible, '[]'::jsonb),
    'ineligible',    v_inelig,
    'withheld_count', jsonb_array_length(v_inelig));
end
$$;

-- --- §8: the copied quote --------------------------------------------
-- "The server composes the text. The client sends only rate_id, direction,
--  amount and markup_bps." No price is accepted, ever.
create or replace function public.record_quote_copy(
  p_rate_id    uuid,
  p_direction  text,
  p_amount     text default null,
  p_markup_bps text default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a         app.actor_t;
  c         record;
  v_mv      public.markup_versions;
  v_amount  numeric;
  v_markup  numeric;
  v_rate    numeric;
  v_counter numeric;
  v_text    text;
  v_side    text;
begin
  a := app.require_staff(array['rm_viewer','backbone_operator','backbone_admin']);

  v_side := app.side_for_direction(p_direction);
  if v_side is null then
    raise exception 'direction must be client_sells_base or client_buys_base'
      using errcode = '22023';
  end if;

  select r.*, p.status as partner_status, p.convention_confirmed_at,
         pp.active as pair_active, cp.id as currency_pair_id,
         cp.base_ccy, cp.quote_ccy
    into c
    from public.rates r
    join public.partners      p  on p.id  = r.partner_id
    join public.partner_pairs pp on pp.id = r.partner_pair_id
    join public.currency_pairs cp on cp.id = pp.currency_pair_id
   where r.id = p_rate_id;
  if not found then
    raise exception 'no such rate' using errcode = '23503';
  end if;

  v_amount := nullif(trim(coalesce(p_amount, '')), '')::numeric;

  select * into v_mv
    from public.markup_versions
   where currency_pair_id = c.currency_pair_id and status = 'active';
  if v_mv.id is null then
    raise exception 'no active markup for this pair; nothing can be quoted'
      using errcode = '22023';
  end if;

  v_markup := coalesce(nullif(trim(coalesce(p_markup_bps, '')), '')::numeric, v_mv.default_bps);
  if v_markup < v_mv.min_bps or v_markup > v_mv.max_bps then
    raise exception 'markup % bps is outside the active band (% to %)',
      v_markup, v_mv.min_bps, v_mv.max_bps using errcode = '22023';
  end if;

  -- §8: eligibility is re-run here, not trusted from the board.
  if c.partner_status <> 'active'            then raise exception 'partner inactive' using errcode = '22023'; end if;
  if c.convention_confirmed_at is null       then raise exception 'convention not confirmed' using errcode = '22023'; end if;
  if not c.pair_active                       then raise exception 'pair not offered' using errcode = '22023'; end if;
  if c.withdrawn_at is not null              then raise exception 'withdrawn by partner' using errcode = '22023'; end if;
  if c.superseded_by is not null             then raise exception 'superseded' using errcode = '22023'; end if;
  if now() >= c.valid_until                  then raise exception 'expired' using errcode = '22023'; end if;
  if v_side = 'bid' and c.partner_bid is null then raise exception 'partner quotes one side only' using errcode = '22023'; end if;
  if v_side = 'ask' and c.partner_ask is null then raise exception 'partner quotes one side only' using errcode = '22023'; end if;
  if v_amount is not null then
    if c.size_status = 'unconfirmed' then
      raise exception 'size not confirmed by partner' using errcode = '22023';
    end if;
    if not (v_amount >= c.min_size and (c.max_size is null or v_amount <= c.max_size)) then
      raise exception 'outside size range' using errcode = '22023';
    end if;
  end if;

  -- Recomputed from the STORED rate and the ACTIVE markup version.
  v_rate := app.client_rate(c.partner_bid, c.partner_ask, p_direction, v_markup);
  v_counter := case when v_amount is not null then round(v_amount * v_rate, 2) end;

  -- §8: the text, in the order the spec states. It carries no partner name,
  -- no partner raw rate, no markup and no spread. "Best execution" appears
  -- nowhere in this application (§7).
  v_text :=
      c.base_ccy || '/' || c.quote_ccy || ' -- client '
      || case when p_direction = 'client_sells_base' then 'sells ' else 'buys ' end
      || c.base_ccy || E'\n'
    || case when v_amount is not null
            then 'Amount: ' || trim(to_char(v_amount, 'FM999,999,999,999,990.00'))
                 || ' ' || c.base_ccy || E'\n'
            else '' end
    || 'Rate: ' || trim(to_char(v_rate, 'FM999,999,999,990.00999999')) || E'\n'
    || case when v_counter is not null
            then case when p_direction = 'client_sells_base' then 'You receive: ' else 'You pay: ' end
                 || c.quote_ccy || ' ' || trim(to_char(v_counter, 'FM999,999,999,999,990.00')) || E'\n'
            else '' end
    || 'Rate as at: '
       || to_char(c.observed_at at time zone 'Asia/Singapore', 'DD Mon YYYY HH24:MI') || ' SGT' || E'\n'
    || 'Valid until: '
       || to_char(c.valid_until at time zone 'Asia/Singapore', 'DD Mon YYYY HH24:MI') || ' SGT' || E'\n\n'
    || 'Indicative only. Not a firm quote and not an offer to trade. '
    || 'Subject to confirmation and availability at the time of dealing.';

  -- §11.7 / §18.4: the authoritative record of what MetaComp quoted.
  -- Retained indefinitely -- it is the pricing record.
  perform app.audit(a, 'quote.copy', 'rate', p_rate_id::text, c.partner_id,
                    jsonb_build_object(
                      'currency_pair_id', c.currency_pair_id,
                      'direction',        p_direction,
                      'amount',           v_amount::text,
                      'markup_bps',       v_markup::text,
                      'markup_version_id', v_mv.id,
                      'partner_bid',      c.partner_bid::text,
                      'partner_ask',      c.partner_ask::text,
                      'client_rate',      v_rate::text,
                      'counter_amount',   v_counter::text,
                      'observed_at',      c.observed_at,
                      'valid_until',      c.valid_until));

  return jsonb_build_object(
    'rate_id',        p_rate_id,
    'client_rate',    v_rate::text,
    'counter_amount', v_counter::text,
    'markup_bps',     v_markup::text,
    'quote_text',     v_text);
end
$$;

grant execute on function
  public.board_rates(uuid, text, text, text),
  public.record_quote_copy(uuid, text, text, text)
  to authenticated;
