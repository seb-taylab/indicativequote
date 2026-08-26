-- =====================================================================
-- 0005  Helper functions, current-rates view, read grants, RLS
-- Spec §11.8, §12.3, §12.4, §12.6
-- =====================================================================

-- --- §12.4 Helper functions -------------------------------------------
-- Every SECURITY DEFINER function carries `set search_path = ''` and
-- schema-qualifies every object. An empty search path is stricter than a
-- pinned one: an unqualified name becomes an error at CREATE time rather
-- than a resolution decided at call time by the caller's path. (TM6)
--
-- All helpers filter status = 'active', which is what makes revocation
-- effective on the next request regardless of token state (TM8, §19).

create or replace function app.principal_id() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id from public.principals p
   where p.auth_user_id = auth.uid() and p.status = 'active'
$$;

create or replace function app.staff_role() returns text
language sql stable security definer
set search_path = ''
as $$
  select sp.role
    from public.principals p
    join public.staff_profiles sp on sp.principal_id = p.id
   where p.auth_user_id = auth.uid() and p.status = 'active'
$$;

create or replace function app.partner_id() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select pm.partner_id
    from public.principals p
    join public.partner_memberships pm on pm.principal_id = p.id
   where p.auth_user_id = auth.uid() and p.status = 'active'
$$;

-- Additive to §12.4. The RLS matrix requires "partner_admin also same-partner
-- rows" on `principals`, which cannot be expressed with the three helpers
-- the spec lists. Same shape, same guarantees.
create or replace function app.partner_role() returns text
language sql stable security definer
set search_path = ''
as $$
  select pm.role
    from public.principals p
    join public.partner_memberships pm on pm.principal_id = p.id
   where p.auth_user_id = auth.uid() and p.status = 'active'
$$;

-- No helper uses LIMIT 1: partner_memberships and staff_profiles are keyed
-- on principal_id, so more than one answer is not possible.

-- Granted to `authenticated` because RLS policy expressions are evaluated as
-- the querying role. V2 revoked its policy helper from everyone and then
-- called it inside a policy, so every query against that table would have
-- failed with a permission error.
grant execute on function
  app.principal_id(), app.staff_role(), app.partner_id(), app.partner_role()
  to authenticated;

-- --- §11.8 The current-rates view -------------------------------------
-- security_invoker = true is not optional. Without it the view runs as its
-- owner and every policy underneath it is bypassed. (TM7, T22)
--
-- Deliberately omits submission_id -- a partner-visible surface should not
-- expose the envelope key -- and carries no markup and no client rate.
create view public.v_current_rates
with (security_invoker = true)
as
select r.id, r.partner_id, r.partner_pair_id,
       r.partner_bid, r.partner_ask,
       r.size_status, r.min_size, r.max_size,
       r.observed_at, r.submitted_at, r.valid_from,
       r.expiry_warning_at, r.valid_until,
       r.normalised_from_inverse, r.correction_of,
       p.slug          as partner_slug,
       p.display_name  as partner_name,
       pp.quote_mode,
       cp.id           as currency_pair_id,
       cp.base_ccy, cp.quote_ccy,
       case
         when p.status <> 'active'
           or pp.active = false
           or p.convention_confirmed_at is null then 'unavailable'
         when now() >= r.valid_until                then 'expired'
         when now() >= r.expiry_warning_at          then 'expiring'
         else 'live'
       end as status
from public.rates r
join public.partners       p  on p.id  = r.partner_id
join public.partner_pairs  pp on pp.id = r.partner_pair_id
join public.currency_pairs cp on cp.id = pp.currency_pair_id
where r.superseded_by is null
  and r.withdrawn_at is null;

-- --- §12.3 Read grants ------------------------------------------------
-- No INSERT, UPDATE or DELETE is granted to any application role on any
-- table. D2: §13 is the complete write surface.
grant select on
  public.partners, public.partner_pairs,
  public.currencies, public.currency_pairs,
  public.rates, public.audit_events,
  public.principals, public.staff_profiles, public.partner_memberships,
  public.markup_versions, public.v_current_rates
to authenticated;

grant select on public.rate_submissions to authenticated;   -- RLS excludes rm_viewer

-- --- §12.6 RLS: enabled on every table, defence in depth --------------
alter table public.currencies          enable row level security;
alter table public.currency_pairs      enable row level security;
alter table public.partners            enable row level security;
alter table public.principals          enable row level security;
alter table public.staff_profiles      enable row level security;
alter table public.partner_memberships enable row level security;
alter table public.partner_pairs       enable row level security;
alter table public.rate_submissions    enable row level security;
alter table public.rates               enable row level security;
alter table public.markup_versions     enable row level security;
alter table public.audit_events        enable row level security;

-- No table has an INSERT, UPDATE, DELETE or FOR ALL policy. Every policy
-- below is FOR SELECT. Mutation is RPC-only (D2).

-- currencies / currency_pairs: partner sees active only, staff sees all
create policy currencies_partner_read on public.currencies for select
  using (active and app.partner_id() is not null);
create policy currencies_staff_read on public.currencies for select
  using (app.staff_role() is not null);

create policy currency_pairs_partner_read on public.currency_pairs for select
  using (active and app.partner_id() is not null);
create policy currency_pairs_staff_read on public.currency_pairs for select
  using (app.staff_role() is not null);

-- partners: partner sees own row, staff sees all
create policy partners_partner_read on public.partners for select
  using (id = app.partner_id());
create policy partners_staff_read on public.partners for select
  using (app.staff_role() is not null);

-- principals: own row always; partner_admin also its own partner's rows;
-- backbone operator and admin see all. rm_viewer gets own row only.
create policy principals_self_read on public.principals for select
  using (id = app.principal_id());
create policy principals_partner_admin_read on public.principals for select
  using (
    app.partner_role() = 'partner_admin'
    and id in (
      select pm.principal_id from public.partner_memberships pm
       where pm.partner_id = app.partner_id()
    )
  );
create policy principals_backbone_read on public.principals for select
  using (app.staff_role() in ('backbone_operator','backbone_admin'));

-- staff_profiles: no partner policy, by design (T4)
create policy staff_profiles_self on public.staff_profiles for select
  using (principal_id = app.principal_id() and app.staff_role() is not null);
create policy staff_profiles_backbone on public.staff_profiles for select
  using (app.staff_role() in ('backbone_operator','backbone_admin'));

-- partner_memberships: partner sees own partner's rows; rm_viewer none (T5)
create policy memberships_partner_read on public.partner_memberships for select
  using (partner_id = app.partner_id());
create policy memberships_backbone_read on public.partner_memberships for select
  using (app.staff_role() in ('backbone_operator','backbone_admin'));

-- partner_pairs: partner sees own, staff sees all
create policy partner_pairs_partner_read on public.partner_pairs for select
  using (partner_id = app.partner_id());
create policy partner_pairs_staff_read on public.partner_pairs for select
  using (app.staff_role() is not null);

-- rate_submissions: carries raw_input, client IP and user agent, none of
-- which an RM needs to price a ticket. No rm_viewer policy, by design (T7).
create policy submissions_partner_read on public.rate_submissions for select
  using (partner_id = app.partner_id());
create policy submissions_backbone_read on public.rate_submissions for select
  using (app.staff_role() in ('backbone_operator','backbone_admin'));

-- rates: partner sees own partner's rows, staff sees all (T1)
create policy rates_partner_read on public.rates for select
  using (partner_id = app.partner_id());
create policy rates_staff_read on public.rates for select
  using (app.staff_role() is not null);

-- markup_versions: no partner policy, by design. The only join from rates to
-- markup is board_rates, which is staff-only. (TM2, T3)
create policy markup_staff_read on public.markup_versions for select
  using (app.staff_role() is not null);

-- audit_events: a partner sees its own rate events only; rm_viewer none (T8)
create policy audit_partner_read on public.audit_events for select
  using (partner_id = app.partner_id() and action like 'rate.%');
create policy audit_backbone_read on public.audit_events for select
  using (app.staff_role() in ('backbone_operator','backbone_admin'));
