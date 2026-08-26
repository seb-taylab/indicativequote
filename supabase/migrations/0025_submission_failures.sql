-- =====================================================================
-- 0025  Submission failures: making §9's "recent failures" possible
-- Spec §9, §18.2, §2. Closes docs/spec-findings.md F10.
--
-- THE TENSION F10 RECORDED.
--
-- §9 wants the health page to show "submissions in the last 24 hours with
-- error_count > 0, with the reasons", and §18.2 alerts on "more than 2 for one
-- partner in an hour", because -- §2 -- "a partner hitting errors silently
-- stops using the product". That is the adoption risk the whole product rests
-- on.
--
-- But §6.4 makes a submission ATOMIC: a batch that fails validation raises and
-- the transaction is discarded, envelope included. A failed submission leaves
-- NO ROW. So error_count can only ever be 0, and the one signal an operator
-- most needs is the one rate_submissions cannot hold.
--
-- The two requirements are in direct tension and cannot both be met inside one
-- transaction. Recording the attempt inside it would mean writing the envelope
-- outside §6.4's guarantee; that is the wrong trade, because atomicity is what
-- makes "either every confirmed row is stored or none is" true.
--
-- RESOLUTION: a separate log, written by a SEPARATE CALL after the failure has
-- already rolled back. The route catches the error from submit_rates and calls
-- record_submission_failure(), which is its own transaction and therefore
-- survives. §6.4 is untouched.
--
-- WHAT IT DELIBERATELY DOES NOT STORE.
-- No raw_input, no rate values. §18.2 already forbids them in logs, and
-- duplicating a partner's pasted text here would put the same personal data
-- outside §18.4's 90-day retention regime, in a table nobody would think to
-- purge. The reason and the row count are what §9 asks for and are enough to
-- act on.
-- =====================================================================

create table public.submission_failures (
  id           bigserial primary key,
  partner_id   uuid        not null references public.partners(id) on delete restrict,
  principal_id uuid        references public.principals(id),
  occurred_at  timestamptz not null default now(),
  -- The error the partner was shown. Never the input that caused it.
  reason       text        not null,
  sqlstate     text,
  row_count    integer,
  client_ip    inet
);

create index submission_failures_partner_time
  on public.submission_failures (partner_id, occurred_at desc);
create index submission_failures_time
  on public.submission_failures (occurred_at desc);

comment on table public.submission_failures is
  'Attempted submissions that failed validation. Written by a separate transaction '
  'because 6.4 discards the failing one. Holds no raw_input and no rate values.';

alter table public.submission_failures enable row level security;

grant select on public.submission_failures to authenticated;

-- Same shape as rate_submissions (§12.6): a partner sees its own, backbone
-- operators and admins see all, rm_viewer sees none -- an RM prices tickets and
-- does not need to know which partners are struggling to submit.
create policy submission_failures_partner_read on public.submission_failures for select
  using (partner_id = app.partner_id());
create policy submission_failures_backbone_read on public.submission_failures for select
  using (app.staff_role() in ('backbone_operator','backbone_admin'));

-- Called by the server route AFTER submit_rates has raised and rolled back.
-- Its own transaction, so it is not discarded with the submission.
create or replace function public.record_submission_failure(
  p_reason    text,
  p_sqlstate  text default null,
  p_row_count integer default null
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_ip inet;
begin
  a := app.require_partner(array['partner_user','partner_admin']);

  begin
    v_ip := nullif(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', '')::inet;
  exception when others then v_ip := null;
  end;

  insert into public.submission_failures
    (partner_id, principal_id, reason, sqlstate, row_count, client_ip)
  values
    (a.partner_id, a.principal_id, left(p_reason, 500), p_sqlstate, p_row_count, v_ip);
end
$$;

grant execute on function public.record_submission_failure(text, text, integer) to authenticated;

-- §9's health page, now with a source to read.
create or replace function public.partner_health()
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare a app.actor_t; v_rows jsonb; v_failures jsonb;
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  select coalesce(jsonb_agg(x order by x->>'partner_name', x->>'pair'), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
             'partner_id', p.id, 'partner_name', p.display_name, 'partner_slug', p.slug,
             'partner_status', p.status, 'partner_pair_id', pp.id,
             'pair', cp.base_ccy || '/' || cp.quote_ccy, 'currency_pair_id', cp.id,
             'current_rates', coalesce(cur.n, 0),
             'last_submission_at', cur.last_submitted,
             'soonest_expiry', cur.soonest_valid_until,
             'state', case
                 when p.convention_confirmed_at is null then 'unconfirmed_convention'
                 when p.status <> 'active'              then 'partner_inactive'
                 when coalesce(cur.n,0) = 0             then 'missing'
                 when cur.soonest_valid_until <= now()  then 'expired'
                 when cur.soonest_warning_at  <= now()  then 'expiring'
                 when mv.id is null                     then 'no_active_markup'
                 else 'healthy' end) as x
      from public.partner_pairs pp
      join public.partners p on p.id = pp.partner_id
      join public.currency_pairs cp on cp.id = pp.currency_pair_id
      left join lateral (
        select count(*) as n, max(r.submitted_at) as last_submitted,
               min(r.valid_until) as soonest_valid_until,
               min(r.expiry_warning_at) as soonest_warning_at
          from public.rates r
         where r.partner_pair_id = pp.id
           and r.superseded_by is null and r.withdrawn_at is null
      ) cur on true
      left join public.markup_versions mv
             on mv.currency_pair_id = cp.id and mv.status = 'active'
     where pp.active
  ) q;

  -- §9: "Recent failures -- submissions in the last 24 hours with error_count
  -- > 0, with the reasons." Grouped per partner so §18.2's "more than 2 for
  -- one partner in an hour" is answerable, and the reasons are listed.
  select coalesce(jsonb_agg(f order by (f->>'failures')::int desc), '[]'::jsonb)
    into v_failures
  from (
    select jsonb_build_object(
             'partner_id', sf.partner_id,
             'partner_name', p.display_name,
             'failures', count(*),
             'in_last_hour', count(*) filter (where sf.occurred_at > now() - interval '1 hour'),
             'last_at', max(sf.occurred_at),
             'reasons', (
               select jsonb_agg(distinct left(r2.reason, 200))
                 from public.submission_failures r2
                where r2.partner_id = sf.partner_id
                  and r2.occurred_at > now() - interval '24 hours')) as f
      from public.submission_failures sf
      join public.partners p on p.id = sf.partner_id
     where sf.occurred_at > now() - interval '24 hours'
     group by sf.partner_id, p.display_name
  ) g;

  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
                 from (select x->>'state' as state, count(*) as n
                         from jsonb_array_elements(v_rows) x group by 1) c),
    'partner_pairs', v_rows,
    'recent_failures', v_failures,
    'generated_at', now());
end
$fn$;
