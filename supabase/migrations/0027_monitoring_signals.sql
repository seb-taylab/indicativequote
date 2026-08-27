-- =====================================================================
-- 0027  §18.2 monitoring signals
--
-- §18.2 is a table of seven signals, each with a threshold and an action.
-- Exactly one of them had been implemented: the purge job's 25-hour overdue
-- check, in 0024. The other six existed only as a table in a document.
--
-- That matters most for the third row. §19/TM12 makes the sign-in response
-- byte-identical whether an address is known, unknown or revoked -- which is
-- the correct defence against enumeration, and which also means an enumeration
-- attempt is INVISIBLE from the application by design. §18.2's "more than 10
-- denials in ten minutes" is the compensating control, and without it the
-- byte-identical response is a blindfold rather than a defence.
--
-- Five of the seven can be answered from this database. Two cannot: RPC error
-- rate and board latency are properties of the edge, measured where requests
-- are served. Those two are RETURNED ANYWAY, marked as not observable here and
-- naming where they are measured instead. A monitoring page that silently
-- lists five of seven signals reads as "all clear" -- the same failure N8
-- records for a test suite that quietly skips.
-- =====================================================================

create or replace function public.monitoring_signals()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  a app.actor_t;
  v_failures    integer;
  v_fail_partner text;
  v_denials     integer;
  v_stale       integer;
  v_purge_last  timestamptz;
  v_lock_wait   numeric;
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  -- Row 2. "submit_rates failures: more than 2 for one partner in an hour."
  -- Per PARTNER, not in total: three partners with one failure each is three
  -- people mistyping, while one partner with three is a partner who is about
  -- to give up and go back to e-mail (§9, "a partner hitting errors silently
  -- stops using the product").
  select coalesce(max(c), 0), (array_agg(display_name order by c desc))[1]
    into v_failures, v_fail_partner
    from (
      select p.display_name, count(*)::integer as c
        from public.submission_failures f
        join public.partners p on p.id = f.partner_id
       where f.occurred_at > now() - interval '1 hour'
       group by p.display_name
    ) s;

  -- Row 3. "Sign-in denials: more than 10 in ten minutes."
  select count(*)::integer into v_denials
    from public.audit_events
   where action = 'access.signin_denied'
     and occurred_at > now() - interval '10 minutes';

  -- Row 5. "Partner-pairs with no current rate for more than one hard TTL."
  -- The TTL is per partner, so the comparison has to be per partner too.
  -- A pair that has NEVER had a rate counts: it has been without one for
  -- longer than any TTL.
  select count(*)::integer into v_stale
    from public.partner_pairs pp
    join public.partners p on p.id = pp.partner_id
   where pp.active
     and p.status = 'active'
     and not exists (
       select 1 from public.rates r
        where r.partner_pair_id = pp.id
          and r.superseded_by is null
          and r.withdrawn_at is null
          and r.valid_until > now()
     )
     and coalesce(
           (select max(r2.valid_until) from public.rates r2 where r2.partner_pair_id = pp.id),
           pp.added_at
         ) < now() - make_interval(mins => p.hard_ttl_minutes);

  -- Row 7. "Purge job did not run in 25 hours."
  select max(ran_at) into v_purge_last
    from app.job_runs where job_name = 'purge_raw_input';

  -- Row 6. "Advisory-lock wait time above 2s."
  -- This is a live sample, not a window: it reports what is waiting RIGHT NOW.
  -- submit_rates takes advisory locks per partner-pair (§12.5), so sustained
  -- contention shows up here, but a spike between two page loads will not.
  -- Said plainly in `note` rather than left to be assumed away.
  select coalesce(max(extract(epoch from (clock_timestamp() - a2.query_start))), 0)::numeric(10,2)
    into v_lock_wait
    from pg_catalog.pg_locks l
    join pg_catalog.pg_stat_activity a2 on a2.pid = l.pid
   where l.locktype = 'advisory' and not l.granted;

  return jsonb_build_array(
    jsonb_build_object(
      'key', 'rpc_errors',
      'label', 'RPC error rate',
      'definition', 'Any 5xx from a database RPC',
      'threshold', 'any 5xx',
      'action', 'alert',
      'observable', false,
      'note', 'Measured where requests are served, not in the database. Supabase project logs, and the Vercel runtime logs for server actions.'),

    jsonb_build_object(
      'key', 'submission_failures',
      'label', 'Submission failures, one partner, last hour',
      'definition', 'submit_rates calls that failed, grouped by partner',
      'threshold', 'more than 2',
      'action', 'alert',
      'observable', true,
      'value', v_failures,
      'breached', v_failures > 2,
      'subject', v_fail_partner),

    jsonb_build_object(
      'key', 'signin_denials',
      'label', 'Sign-in denials, last ten minutes',
      'definition', 'access.signin_denied audit events',
      'threshold', 'more than 10',
      'action', 'alert -- enumeration attempt, or a broken invitation',
      'observable', true,
      'value', v_denials,
      'breached', v_denials > 10),

    jsonb_build_object(
      'key', 'board_latency',
      'label', 'Board p95 latency',
      'definition', 'Time to render the board',
      'threshold', 'above 800ms',
      'action', 'investigate',
      'observable', false,
      'note', 'Measured at the edge. Vercel Analytics, or the Supabase log explorer for the query half.'),

    jsonb_build_object(
      'key', 'stale_pairs',
      'label', 'Active partner-pairs with no current rate',
      'definition', 'Beyond that partner''s own hard TTL',
      'threshold', 'any, for more than one hard TTL',
      'action', 'daily digest to backbone',
      'observable', true,
      'value', v_stale,
      'breached', v_stale > 0),

    jsonb_build_object(
      'key', 'advisory_lock_wait',
      'label', 'Advisory-lock wait, right now',
      'definition', 'Longest ungranted advisory lock wait',
      'threshold', 'above 2s',
      'action', 'investigate -- submission contention',
      'observable', true,
      'value', v_lock_wait,
      'breached', v_lock_wait > 2,
      'note', 'A live sample. Sustained contention shows here; a spike between two page loads does not.'),

    jsonb_build_object(
      'key', 'purge_job',
      'label', 'Retention purge job',
      'definition', 'Last successful run of purge_raw_input',
      'threshold', 'did not run in 25 hours',
      'action', 'alert',
      'observable', true,
      'value', v_purge_last,
      'breached', v_purge_last is null or v_purge_last < now() - interval '25 hours')
  );
end
$$;

-- §12.2 / TM6: execute to `authenticated` only. The 0007 event trigger has
-- already revoked PUBLIC and anon; require_staff does the rest, so a partner
-- holding a valid session still cannot call this.
grant execute on function public.monitoring_signals() to authenticated;

comment on function public.monitoring_signals() is
  '§18.2 monitoring signals, evaluated against their thresholds. Staff only. '
  'Signals not observable in the database are returned with observable=false '
  'and a note naming where they are measured, rather than omitted.';
