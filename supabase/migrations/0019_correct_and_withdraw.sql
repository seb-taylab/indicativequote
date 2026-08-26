-- =====================================================================
-- 0019  Correction and withdrawal
-- Spec §6.6, §13.1
--
-- "Neither issues a DELETE. There is no delete path in the application, the
--  RPC surface or the grant set."
--
-- The load-bearing rule here is inherited validity. A correction restates a
-- price the partner ALREADY COMMITTED TO until a given time; fixing a typo
-- does not extend the life of the quote. So valid_until and expiry_warning_at
-- are copied from the corrected row, not recomputed from the partner's TTL.
-- Getting this wrong would let a partner refresh an ageing book by "correcting"
-- it, which is exactly the staleness the whole product is trying to kill.
-- =====================================================================

create or replace function public.correct_rate(
  p_rate_id uuid,
  p_bid     text default null,
  p_ask     text default null,
  p_size    jsonb default null,
  p_reason  text default null,
  p_idem    text default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a app.actor_t;
  t public.rates;
  v_pp public.partner_pairs;
  v_sub uuid; v_new uuid; v_existing uuid;
  v_bid numeric; v_ask numeric;
  v_ss text; v_min numeric; v_max numeric;
  v_observed timestamptz;
begin
  a := app.require_partner(array['partner_user','partner_admin']);

  if p_idem is not null and length(trim(p_idem)) > 0 then
    select id into v_existing from public.rate_submissions
     where partner_id = a.partner_id and idempotency_key = trim(p_idem);
    if found then
      return jsonb_build_object('submission_id', v_existing, 'idempotent_replay', true,
        'rate_id', (select id from public.rates where submission_id = v_existing limit 1));
    end if;
  end if;

  select * into t from public.rates where id = p_rate_id;
  if not found then
    raise exception 'no such rate' using errcode = '23503';
  end if;
  -- Tenant boundary.
  if t.partner_id <> a.partner_id then
    raise exception 'that rate belongs to another partner' using errcode = '42501';
  end if;
  -- §6.6: "available only while the corrected row is current".
  if t.superseded_by is not null then
    raise exception 'that rate has already been superseded; correct the current one'
      using errcode = '22023';
  end if;
  if t.withdrawn_at is not null then
    raise exception 'that rate was withdrawn' using errcode = '22023';
  end if;

  select * into v_pp from public.partner_pairs where id = t.partner_pair_id;

  -- Absent values keep what the original row had: a correction states what
  -- changed, not the whole row.
  v_bid := coalesce(nullif(trim(coalesce(p_bid,'')),'')::numeric, t.partner_bid);
  v_ask := coalesce(nullif(trim(coalesce(p_ask,'')),'')::numeric, t.partner_ask);

  if v_bid is null and v_ask is null then
    raise exception 'a rate needs at least one side' using errcode = '22023';
  end if;
  if v_pp.quote_mode = 'two_way' and (v_bid is null or v_ask is null) then
    raise exception 'this pair is quoted two-way; both bid and ask are required'
      using errcode = '22023';
  elsif v_pp.quote_mode = 'bid_only' and v_ask is not null then
    raise exception 'this pair is bid-only' using errcode = '22023';
  elsif v_pp.quote_mode = 'ask_only' and v_bid is not null then
    raise exception 'this pair is ask-only' using errcode = '22023';
  end if;
  if v_bid is not null and v_ask is not null and v_bid > v_ask then
    raise exception 'bid % is higher than ask %. Swap them or correct one', v_bid, v_ask
      using errcode = '22023';
  end if;

  if p_size is null then
    v_ss := t.size_status; v_min := t.min_size; v_max := t.max_size;
  else
    v_ss  := coalesce(p_size->>'size_status', t.size_status);
    v_min := nullif(trim(coalesce(p_size->>'min_size','')),'')::numeric;
    v_max := nullif(trim(coalesce(p_size->>'max_size','')),'')::numeric;
    if v_ss = 'unconfirmed' then
      v_min := null; v_max := null;
    elsif v_min is null then
      raise exception 'a confirmed size needs a minimum' using errcode = '22023';
    elsif v_max is not null and v_max < v_min then
      raise exception 'maximum % is below minimum %', v_max, v_min using errcode = '22023';
    end if;
  end if;

  v_observed := coalesce((p_size->>'observed_at')::timestamptz, now());

  perform pg_advisory_xact_lock(hashtextextended(t.partner_pair_id::text, 0));

  -- §6.6: a correction gets its OWN envelope, pointing at the one it corrects.
  insert into public.rate_submissions
    (partner_id, submitted_by, source_type, corrects_submission_id,
     idempotency_key, row_count, error_count)
  values
    (a.partner_id, a.principal_id, 'correction', t.submission_id,
     nullif(trim(coalesce(p_idem,'')),''), 1, 0)
  returning id into v_sub;

  -- Insert first, then supersede -- §12.5, same order as submit_rates.
  insert into public.rates
    (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
     size_status, min_size, max_size,
     observed_at, submitted_at, valid_from,
     expiry_warning_at, valid_until,          -- INHERITED, never recomputed
     correction_of, normalised_from_inverse)
  values
    (v_sub, a.partner_id, t.partner_pair_id, v_bid, v_ask,
     v_ss, v_min, v_max,
     v_observed, now(), t.valid_from,
     t.expiry_warning_at, t.valid_until,
     t.id, t.normalised_from_inverse)
  returning id into v_new;

  update public.rates
     set superseded_by = v_new, superseded_at = now()
   where id = t.id;

  perform app.audit(a, 'rate.correct', 'rate', v_new::text, a.partner_id,
                    jsonb_build_object(
                      'corrects_rate_id', t.id,
                      'submission_id', v_sub,
                      'from', jsonb_build_object('bid', t.partner_bid::text, 'ask', t.partner_ask::text),
                      'to',   jsonb_build_object('bid', v_bid::text, 'ask', v_ask::text),
                      'valid_until_inherited', t.valid_until,
                      'reason', p_reason));

  return jsonb_build_object(
    'rate_id', v_new, 'submission_id', v_sub, 'corrects_rate_id', t.id,
    'partner_bid', v_bid::text, 'partner_ask', v_ask::text,
    'valid_until', t.valid_until, 'expiry_warning_at', t.expiry_warning_at);
end
$$;

create or replace function public.withdraw_rate(
  p_rate_id uuid,
  p_reason  text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; t public.rates;
begin
  a := app.require_partner(array['partner_user','partner_admin']);

  select * into t from public.rates where id = p_rate_id;
  if not found then
    raise exception 'no such rate' using errcode = '23503';
  end if;
  if t.partner_id <> a.partner_id then
    raise exception 'that rate belongs to another partner' using errcode = '42501';
  end if;
  if t.withdrawn_at is not null then
    return jsonb_build_object('rate_id', p_rate_id, 'withdrawn', true, 'already_withdrawn', true);
  end if;
  if t.superseded_by is not null then
    raise exception 'that rate is no longer current' using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to withdraw a rate' using errcode = '22023';
  end if;

  -- §6.6: ineligible immediately (E4), gone from the board, retained in
  -- history. Not a delete.
  update public.rates
     set withdrawn_at = now(), withdrawn_by = a.principal_id, withdrawn_reason = trim(p_reason)
   where id = p_rate_id;

  perform app.audit(a, 'rate.withdraw', 'rate', p_rate_id::text, a.partner_id,
                    jsonb_build_object('reason', trim(p_reason),
                                       'partner_pair_id', t.partner_pair_id));

  return jsonb_build_object('rate_id', p_rate_id, 'withdrawn', true);
end
$$;

grant execute on function
  public.correct_rate(uuid, text, text, jsonb, text, text),
  public.withdraw_rate(uuid, text)
  to authenticated;
