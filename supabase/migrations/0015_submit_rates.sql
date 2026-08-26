-- =====================================================================
-- 0015  submit_rates
-- Spec §13.1, §12.5, §10.4, §10.5, §6.2, §6.4
--
-- The one write path for rates. Validates, stamps validity, executes the
-- supersession sequence, and returns per-row outcomes.
--
-- §6.4 atomicity: a submission is atomic over the rows the partner confirmed.
-- Any validation failure raises and the whole transaction is discarded --
-- "either every confirmed row is stored or none is". Rows the partner left in
-- error state never reach here; the grid excludes them.
--
-- THREE THINGS WORTH KNOWING BEFORE CHANGING THIS FUNCTION
--
-- 1. Lock ordering. §12.5 specifies one advisory lock per partner-pair, but a
--    submission commonly touches several pairs. Two concurrent submissions
--    taking those locks in different orders deadlock. Locks are therefore
--    taken over a SORTED array of partner_pair_ids, so every writer acquires
--    them in the same sequence. The spec does not mention this.
--
-- 2. Supersession is by OVERLAP, not by equality. A new band supersedes every
--    current band it overlaps, not only one with identical bounds. Superseding
--    only exact matches would leave an old [0,100000] current alongside a new
--    [0,50000], which the exclusion constraint then rejects at commit -- and
--    the partner would see a constraint error rather than their new book.
--    "A band the submission does not mention stays current" still holds,
--    because a band that is not mentioned does not overlap what is.
--
-- 3. Touching bands are refused, with a message that says how to fix it.
--    numrange(min,max,'[]') is inclusive at both ends, so [0,100000] and
--    [100000,inf) share the ticket 100,000 and the exclusion constraint
--    rejects them -- including §10.4's own worked example. See
--    docs/spec-findings.md F2 and D-F2. The alternative, half-open ranges,
--    would silently exclude 100,000 from a band a partner described as
--    "up to 100k", mis-pricing the exact hurdle [A-2] is about.
-- =====================================================================

create or replace function public.submit_rates(
  p_rows        jsonb,
  p_valid_until timestamptz default null,
  p_raw         text        default null,
  p_idem        text        default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a             app.actor_t;
  v_partner     public.partners;
  v_now         timestamptz := now();
  v_valid_until timestamptz;
  v_warn_at     timestamptz;
  v_sub_id      uuid;
  v_existing    uuid;
  v_pair_ids    uuid[];
  v_pair        uuid;
  v_rows        jsonb;
  r             record;
  c             record;
  v_rate_id     uuid;
  v_results     jsonb := '[]'::jsonb;
  v_renewed     uuid[] := '{}';
  v_state       text;
  v_prior       public.rates;
  v_n           integer;
  v_ip          inet;
  v_ua          text;
begin
  a := app.require_partner(array['partner_user','partner_admin']);

  select * into v_partner from public.partners where id = a.partner_id;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows submitted' using errcode = '22023';
  end if;

  -- --- Idempotency (§6.6, §17) ---------------------------------------
  -- A retried call returns the original submission rather than duplicating it.
  if p_idem is not null and length(trim(p_idem)) > 0 then
    select id into v_existing
      from public.rate_submissions
     where partner_id = a.partner_id and idempotency_key = trim(p_idem);
    if found then
      return jsonb_build_object(
        'submission_id',    v_existing,
        'idempotent_replay', true,
        'rows', coalesce((
          select jsonb_agg(jsonb_build_object('rate_id', rt.id, 'partner_pair_id', rt.partner_pair_id)
                           order by rt.id)
            from public.rates rt where rt.submission_id = v_existing), '[]'::jsonb));
    end if;
  end if;

  -- --- Validity stamps, written once and never re-derived (D5, §10.5) --
  if p_valid_until is null then
    v_valid_until := v_now + make_interval(mins => v_partner.hard_ttl_minutes);
    v_warn_at     := v_now + make_interval(mins => v_partner.soft_ttl_minutes);
  else
    -- D6: the partner may override validity once, for the whole batch.
    if p_valid_until <= v_now then
      raise exception 'the batch expiry is already in the past' using errcode = '22023';
    end if;
    v_valid_until := p_valid_until;
    -- §10.5: the soft window is proportional when valid_until is overridden,
    -- so a shortened batch still warns before it expires rather than after.
    v_warn_at := v_now + (p_valid_until - v_now)
                 * (v_partner.soft_ttl_minutes::numeric / v_partner.hard_ttl_minutes::numeric);
  end if;

  -- --- Expand and shape-check every row -------------------------------
  v_rows := '[]'::jsonb;
  v_n := 0;
  for r in
    select x.*, ord
      from jsonb_array_elements(p_rows) with ordinality e(elem, ord)
      cross join lateral jsonb_to_record(e.elem) as x(
        currency_pair_id uuid,
        bid text, ask text,
        size_status text,
        min_size text, max_size text,
        observed_at timestamptz,
        normalised_from_inverse boolean)
     order by ord
  loop
    v_n := v_n + 1;
    declare
      v_pp        public.partner_pairs;
      v_bid       numeric;
      v_ask       numeric;
      v_min       numeric;
      v_max       numeric;
      v_ss        text;
    begin
      -- Tenant boundary: the pair must belong to the CALLER's partner. Never
      -- a partner_id from the client. T10.
      select pp.* into v_pp
        from public.partner_pairs pp
       where pp.partner_id = a.partner_id
         and pp.currency_pair_id = r.currency_pair_id;
      if not found then
        raise exception 'row %: that pair is not on your book', v_n using errcode = '23503';
      end if;
      if not v_pp.active then
        raise exception 'row %: that pair is deactivated; reactivate it first', v_n
          using errcode = '22023';
      end if;

      -- §12.7 rule 3: decimals arrive as text and are cast here, so a
      -- malformed value is an error rather than a silent rounding.
      v_bid := nullif(trim(coalesce(r.bid, '')), '')::numeric;
      v_ask := nullif(trim(coalesce(r.ask, '')), '')::numeric;

      if v_bid is null and v_ask is null then
        raise exception 'row %: a rate needs at least one side', v_n using errcode = '22023';
      end if;

      -- §11.4 quote_mode says precisely what is permitted.
      if v_pp.quote_mode = 'two_way' and (v_bid is null or v_ask is null) then
        raise exception 'row %: this pair is quoted two-way; both bid and ask are required', v_n
          using errcode = '22023';
      elsif v_pp.quote_mode = 'bid_only' and v_ask is not null then
        raise exception 'row %: this pair is bid-only', v_n using errcode = '22023';
      elsif v_pp.quote_mode = 'ask_only' and v_bid is not null then
        raise exception 'row %: this pair is ask-only', v_n using errcode = '22023';
      end if;

      -- §6.3 error 1. A crossed rate is an error, never a warning, and is
      -- never silently swapped. The check constraint would catch it; this
      -- raises the sentence the partner can act on.
      if v_bid is not null and v_ask is not null and v_bid > v_ask then
        raise exception 'row %: bid % is higher than ask %. Swap them or correct one', v_n, v_bid, v_ask
          using errcode = '22023';
      end if;

      v_ss  := coalesce(r.size_status, 'unconfirmed');
      if v_ss not in ('confirmed','unconfirmed') then
        raise exception 'row %: size_status must be confirmed or unconfirmed', v_n
          using errcode = '22023';
      end if;
      v_min := nullif(trim(coalesce(r.min_size, '')), '')::numeric;
      v_max := nullif(trim(coalesce(r.max_size, '')), '')::numeric;

      -- D10: unknown size is `unconfirmed`, never unlimited.
      if v_ss = 'unconfirmed' and (v_min is not null or v_max is not null) then
        raise exception 'row %: an unconfirmed size carries no bounds', v_n using errcode = '22023';
      end if;
      if v_ss = 'confirmed' then
        if v_min is null then
          raise exception 'row %: a confirmed size needs a minimum', v_n using errcode = '22023';
        end if;
        if v_min < 0 then
          raise exception 'row %: a size bound cannot be negative', v_n using errcode = '22023';
        end if;
        if v_max is not null and v_max < v_min then
          raise exception 'row %: maximum % is below minimum %', v_n, v_max, v_min
            using errcode = '22023';
        end if;
      end if;

      v_rows := v_rows || jsonb_build_object(
        'ord', v_n,
        'partner_pair_id', v_pp.id,
        'bid', v_bid, 'ask', v_ask,
        'size_status', v_ss,
        'min_size', v_min, 'max_size', v_max,
        'observed_at', coalesce(r.observed_at, v_now),
        'normalised_from_inverse', coalesce(r.normalised_from_inverse, false));
    end;
  end loop;

  -- --- Per-pair consistency, within the batch --------------------------
  for c in
    select (e->>'partner_pair_id')::uuid as pp,
           count(*) as n,
           count(*) filter (where e->>'size_status' = 'unconfirmed') as n_unconf
      from jsonb_array_elements(v_rows) e
     group by 1
  loop
    -- §10.4: a partner-pair is either banded or unbanded. The two cannot mix,
    -- because an unconfirmed row would compete with the bands for the same
    -- ticket with no way to choose between them.
    if c.n_unconf > 0 and c.n > 1 then
      raise exception
        'a pair may carry either one unconfirmed row or several confirmed bands, not both'
        using errcode = '22023';
    end if;
  end loop;

  -- Intra-batch band overlap, including the touching case (F2).
  for c in
    select (x->>'ord')::int      as ord_a,
           (y->>'ord')::int      as ord_b,
           (x->>'partner_pair_id')::uuid as pp,
           (x->>'min_size')::numeric as amin, (x->>'max_size')::numeric as amax,
           (y->>'min_size')::numeric as bmin, (y->>'max_size')::numeric as bmax
      from jsonb_array_elements(v_rows) x
      join jsonb_array_elements(v_rows) y
        on  (x->>'partner_pair_id') = (y->>'partner_pair_id')
        and (x->>'ord')::int < (y->>'ord')::int
     where x->>'size_status' = 'confirmed'
       and y->>'size_status' = 'confirmed'
       and numrange((x->>'min_size')::numeric, (x->>'max_size')::numeric, '[]')
        && numrange((y->>'min_size')::numeric, (y->>'max_size')::numeric, '[]')
  loop
    if c.amax = c.bmin or c.bmax = c.amin then
      -- The F2 case, given its own message because the fix is specific and
      -- the partner would otherwise read "overlapping" about bands they
      -- believe are adjacent.
      raise exception
        'rows % and % meet at %: a ticket of exactly % would match both bands. Raise the upper band''s minimum just above %, or lower the other band''s maximum',
        c.ord_a, c.ord_b, coalesce(c.amax, c.bmax), coalesce(c.amax, c.bmax), coalesce(c.amax, c.bmax)
        using errcode = '22023';
    else
      raise exception 'rows % and % have overlapping size bands', c.ord_a, c.ord_b
        using errcode = '22023';
    end if;
  end loop;

  -- --- §12.5 step 1: serialise every writer for these partner-pairs ----
  -- Sorted, so concurrent submissions touching the same set of pairs acquire
  -- the locks in the same order and cannot deadlock.
  select array_agg(distinct (e->>'partner_pair_id')::uuid order by (e->>'partner_pair_id')::uuid)
    into v_pair_ids
    from jsonb_array_elements(v_rows) e;

  foreach v_pair in array v_pair_ids loop
    perform pg_advisory_xact_lock(hashtextextended(v_pair::text, 0));
  end loop;

  -- --- The submission envelope ----------------------------------------
  begin
    v_ip := nullif(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', '')::inet;
    v_ua := current_setting('request.headers', true)::jsonb ->> 'user-agent';
  exception when others then
    v_ip := null; v_ua := null;   -- not called through PostgREST
  end;

  insert into public.rate_submissions
    (partner_id, submitted_by, source_type, idempotency_key, raw_input,
     row_count, error_count, client_ip, user_agent)
  values
    (a.partner_id, a.principal_id, 'manual_grid', nullif(trim(coalesce(p_idem,'')),''), p_raw,
     jsonb_array_length(v_rows), 0, v_ip, v_ua)
  returning id into v_sub_id;

  -- --- §12.5 step 2: insert the new rows FIRST -------------------------
  -- so superseded_by always points at a row that exists.
  for r in select el.value as elem from jsonb_array_elements(v_rows) el order by (el.value->>'ord')::int
  loop
    declare
      je    jsonb := r.elem;
      v_pp  uuid  := (je->>'partner_pair_id')::uuid;
      v_min numeric := (je->>'min_size')::numeric;
      v_max numeric := (je->>'max_size')::numeric;
      v_ss  text  := je->>'size_status';
    begin
      -- What is this row replacing? Used only to label the outcome (§6.2).
      select * into v_prior
        from public.rates rt
       where rt.partner_pair_id = v_pp
         and rt.superseded_by is null
         and rt.withdrawn_at is null
         and (
           (v_ss = 'unconfirmed' and rt.size_status = 'unconfirmed')
           or (v_ss = 'confirmed' and rt.size_status = 'confirmed'
               and numrange(rt.min_size, rt.max_size, '[]') && numrange(v_min, v_max, '[]'))
         )
       order by rt.submitted_at desc
       limit 1;

      if not found then
        v_state := 'new';
      elsif v_prior.partner_bid is not distinct from (je->>'bid')::numeric
        and v_prior.partner_ask is not distinct from (je->>'ask')::numeric
        and v_prior.min_size    is not distinct from v_min
        and v_prior.max_size    is not distinct from v_max then
        -- §6.2: the partner re-sent the same numbers. That is an assertion
        -- that they are still good, so it inserts a new row with fresh
        -- validity rather than being discarded as "no change".
        v_state := 'renewed';
      else
        v_state := 'updated';
      end if;

      insert into public.rates
        (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
         size_status, min_size, max_size,
         observed_at, submitted_at, valid_from, expiry_warning_at, valid_until,
         normalised_from_inverse)
      values
        (v_sub_id, a.partner_id, v_pp, (je->>'bid')::numeric, (je->>'ask')::numeric,
         v_ss, v_min, v_max,
         (je->>'observed_at')::timestamptz, v_now, v_now, v_warn_at, v_valid_until,
         (je->>'normalised_from_inverse')::boolean)
      returning id into v_rate_id;

      if v_state = 'renewed' then
        v_renewed := v_renewed || v_rate_id;
      end if;

      -- --- §12.5 step 3: supersede what this row replaces --------------
      -- By overlap, and including the mixed-banding resolution: a confirmed
      -- submission retires a current unconfirmed row for the same pair, and
      -- an unconfirmed submission retires every current row for that pair.
      update public.rates rt
         set superseded_by = v_rate_id, superseded_at = v_now
       where rt.partner_pair_id = v_pp
         and rt.id <> v_rate_id
         and rt.superseded_by is null
         and rt.withdrawn_at is null
         and (
           v_ss = 'unconfirmed'
           or rt.size_status = 'unconfirmed'
           or numrange(rt.min_size, rt.max_size, '[]') && numrange(v_min, v_max, '[]')
         );

      v_results := v_results || jsonb_build_object(
        'ord', (je->>'ord')::int,
        'rate_id', v_rate_id,
        'partner_pair_id', v_pp,
        'state', v_state);
    end;
  end loop;

  -- --- §12.5 step 4: commit checks the deferred exclusion constraints --

  perform app.audit(a, 'rate.submit', 'rate_submission', v_sub_id::text, a.partner_id,
                    jsonb_build_object(
                      'row_count', jsonb_array_length(v_rows),
                      'partner_pair_ids', to_jsonb(v_pair_ids),
                      'valid_until', v_valid_until,
                      'validity_overridden', p_valid_until is not null));

  if array_length(v_renewed, 1) > 0 then
    perform app.audit(a, 'rate.renew', 'rate_submission', v_sub_id::text, a.partner_id,
                      jsonb_build_object('rate_ids', to_jsonb(v_renewed),
                                         'count', array_length(v_renewed, 1)));
  end if;

  return jsonb_build_object(
    'submission_id',   v_sub_id,
    'row_count',       jsonb_array_length(v_rows),
    'valid_from',      v_now,
    'expiry_warning_at', v_warn_at,
    'valid_until',     v_valid_until,
    'rows',            v_results);
end
$$;

grant execute on function public.submit_rates(jsonb, timestamptz, text, text) to authenticated;
