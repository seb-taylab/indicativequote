-- =====================================================================
-- 0020  Health, and the raw_input purge
-- Spec §9, §18.4
--
-- §9: "Coverage is a PER PARTNER-PAIR property. A partner may refresh one pair
--  while five others sit expired, and a partner-level 'last submission'
--  conceals exactly that."
--
-- So the unit of this report is the partner-pair, and a partner is "healthy"
-- only when every active pair of theirs is healthy. Reporting a partner as
-- healthy because they submitted *something* today is the failure mode §9 was
-- written to prevent.
-- =====================================================================

create or replace function public.partner_health()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_rows jsonb; v_failures jsonb;
begin
  -- §4: rm_viewer reads the board and copies quotes, "nothing else".
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  select coalesce(jsonb_agg(x order by x->>'partner_name', x->>'pair'), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
             'partner_id',   p.id,
             'partner_name', p.display_name,
             'partner_slug', p.slug,
             'partner_status', p.status,
             'partner_pair_id', pp.id,
             'pair',        cp.base_ccy || '/' || cp.quote_ccy,
             'currency_pair_id', cp.id,
             'current_rates', coalesce(cur.n, 0),
             'last_submission_at', cur.last_submitted,
             'soonest_expiry',     cur.soonest_valid_until,
             -- §9's six signals, per partner-pair.
             'state',
               case
                 when p.convention_confirmed_at is null then 'unconfirmed_convention'
                 when p.status <> 'active'              then 'partner_inactive'
                 when coalesce(cur.n, 0) = 0            then 'missing'
                 when cur.soonest_valid_until    <= now() then 'expired'
                 when cur.soonest_warning_at     <= now() then 'expiring'
                 when mv.id is null                     then 'no_active_markup'
                 else 'healthy'
               end
           ) as x
      from public.partner_pairs pp
      join public.partners      p  on p.id  = pp.partner_id
      join public.currency_pairs cp on cp.id = pp.currency_pair_id
      left join lateral (
        select count(*)            as n,
               max(r.submitted_at) as last_submitted,
               min(r.valid_until)  as soonest_valid_until,
               min(r.expiry_warning_at) as soonest_warning_at
          from public.rates r
         where r.partner_pair_id = pp.id
           and r.superseded_by is null
           and r.withdrawn_at  is null
      ) cur on true
      left join public.markup_versions mv
             on mv.currency_pair_id = cp.id and mv.status = 'active'
     where pp.active
  ) q;

  -- §9: "Recent failures -- submissions in the last 24 hours with
  --  error_count > 0, with the reasons."
  --
  -- submit_rates is atomic (§6.4): a batch either stores completely or raises,
  -- so a FAILED submission leaves no envelope at all and cannot be counted
  -- here. This therefore reports only envelopes explicitly written with
  -- errors -- today, none. The client-side failure count that §18.2 alerts on
  -- ("more than 2 for one partner in an hour") has to come from application
  -- telemetry, not from this table. See docs/spec-findings.md F10.
  select coalesce(jsonb_agg(jsonb_build_object(
           'submission_id', s.id, 'partner_id', s.partner_id,
           'submitted_at', s.submitted_at, 'error_count', s.error_count)), '[]'::jsonb)
    into v_failures
    from public.rate_submissions s
   where s.error_count > 0 and s.submitted_at > now() - interval '24 hours';

  return jsonb_build_object(
    'counts', (
      select coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
        from (select x->>'state' as state, count(*) as n
                from jsonb_array_elements(v_rows) x group by 1) c
    ),
    'partner_pairs',   v_rows,
    'recent_failures', v_failures,
    'generated_at',    now());
end
$$;

grant execute on function public.partner_health() to authenticated;

-- --- §18.4 retention --------------------------------------------------
-- raw_input is the partner's exact pasted text, "which may carry greetings,
-- names or unrelated content". Retained 90 days for dispute resolution over a
-- live rate, then nulled and stamped.
--
-- Stamping raw_input_purged_at rather than simply nulling matters: it
-- distinguishes "this submission had no raw text" from "we deleted it", which
-- is the difference between a gap and a retention record.
create or replace function app.purge_raw_input(p_days integer default 90)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_n integer;
begin
  update public.rate_submissions
     set raw_input = null, raw_input_purged_at = now()
   where raw_input is not null
     and submitted_at < now() - make_interval(days => p_days);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

revoke execute on function app.purge_raw_input(integer) from public, anon, authenticated;

comment on function app.purge_raw_input(integer) is
  '§18.4: nulls raw_input older than 90 days and stamps raw_input_purged_at. '
  'Schedule daily. §18.2 alerts if it has not run in 25 hours.';
