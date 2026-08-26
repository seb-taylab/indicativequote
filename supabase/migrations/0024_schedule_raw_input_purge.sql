-- =====================================================================
-- 0024  Actually run the raw_input purge
-- Spec §18.4 (retention), §18.2 (monitoring), §21.2 (acceptance)
--
-- 0020 created app.purge_raw_input() and nothing ever called it. §21.2 lists
-- "raw_input older than 90 days is nulled and stamped" as an acceptance
-- criterion, and it was simply false: the function existed, the retention did
-- not happen. A retention control that is never executed is a belief, not a
-- control -- the same point §18.3 makes about an unrehearsed backup.
--
-- §18.4 is a PRIVACY obligation, not housekeeping: raw_input is the partner's
-- exact pasted text, "which may carry greetings, names or unrelated content".
-- Retaining it past 90 days because a job was never scheduled is the kind of
-- gap a data-protection review finds, not a test.
--
-- §18.2 also alerts when the "Purge job did not run in 25 hours". Nothing
-- recorded when it last ran, so that alert had nothing to read. app.job_runs
-- gives it a source.
-- =====================================================================

create table if not exists app.job_runs (
  id          bigserial primary key,
  job_name    text        not null,
  ran_at      timestamptz not null default now(),
  rows_affected integer,
  ok          boolean     not null default true,
  detail      text
);
create index if not exists job_runs_name_ran_at on app.job_runs (job_name, ran_at desc);

revoke all on app.job_runs from public, anon, authenticated;

comment on table app.job_runs is
  'Scheduled-job heartbeat. §18.2 alerts when the purge has not run in 25 hours; this is what it reads.';

-- Wrap the purge so every run is recorded, including a failure. A job that
-- fails silently and a job that never ran look identical from the outside,
-- and §18.2 needs to tell them apart.
create or replace function app.run_raw_input_purge(p_days integer default 90)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_n integer;
begin
  v_n := app.purge_raw_input(p_days);
  insert into app.job_runs (job_name, rows_affected, ok)
  values ('purge_raw_input', v_n, true);
  return v_n;
exception when others then
  insert into app.job_runs (job_name, rows_affected, ok, detail)
  values ('purge_raw_input', null, false, sqlerrm);
  raise;
end
$$;

revoke execute on function app.run_raw_input_purge(integer) from public, anon, authenticated;

-- Staff-readable view of the heartbeat, so /admin/health can show it without
-- granting anything on app.job_runs itself.
create or replace function public.job_health()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare a app.actor_t; v_last timestamptz; v_ok boolean; v_rows integer;
begin
  a := app.require_staff(array['backbone_operator','backbone_admin']);

  select ran_at, ok, rows_affected into v_last, v_ok, v_rows
    from app.job_runs
   where job_name = 'purge_raw_input'
   order by ran_at desc
   limit 1;

  return jsonb_build_object(
    'job', 'purge_raw_input',
    'last_run_at', v_last,
    'last_run_ok', v_ok,
    'last_run_rows', v_rows,
    -- §18.2: "Purge job did not run in 25 hours -> alert".
    'overdue', v_last is null or v_last < now() - interval '25 hours',
    'retained_raw_inputs', (select count(*) from public.rate_submissions where raw_input is not null),
    'purged_to_date', (select count(*) from public.rate_submissions where raw_input_purged_at is not null));
end
$$;

grant execute on function public.job_health() to authenticated;
