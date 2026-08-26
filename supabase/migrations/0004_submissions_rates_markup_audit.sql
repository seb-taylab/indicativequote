-- =====================================================================
-- 0004  Submissions, rates, markup, audit
-- Spec §11.5, §11.6, §11.7
-- =====================================================================

create table public.rate_submissions (
  id                     uuid primary key default gen_random_uuid(),
  partner_id             uuid not null references public.partners(id) on delete restrict,
  submitted_by           uuid references public.principals(id),
  source_type            text not null default 'manual_grid'
                           check (source_type in ('manual_grid','correction','api')),
  corrects_submission_id uuid references public.rate_submissions(id),
  source_ref             text,
  source_account         text,
  idempotency_key        text,
  submitted_at           timestamptz not null default now(),
  ingested_at            timestamptz not null default now(),   -- §17: separate from submitted_at
  raw_input              text,
  raw_input_purged_at    timestamptz,                          -- §18.4: 90-day purge stamp
  row_count              integer not null default 0,
  error_count            integer not null default 0,
  client_ip              inet,
  user_agent             text,
  -- §17: an API submission needs no fictional human; a manual one cannot omit its human.
  constraint human_or_machine
    check ((source_type = 'api' and source_account is not null)
        or (source_type <> 'api' and submitted_by is not null)),
  constraint rate_submissions_id_partner unique (id, partner_id)   -- tenant FK target
);
create index on public.rate_submissions (partner_id, submitted_at desc);
create unique index rate_submissions_idem
  on public.rate_submissions (partner_id, idempotency_key)
  where idempotency_key is not null;

-- --- Rates: append-only, immutable, superseded never deleted ----------
create table public.rates (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null,
  partner_id        uuid not null references public.partners(id) on delete restrict,
  partner_pair_id   uuid not null,

  -- D13/§12.7: NUMERIC in the database, text across every boundary.
  partner_bid       numeric(28,14),
  partner_ask       numeric(28,14),

  size_status       text not null check (size_status in ('confirmed','unconfirmed')),
  min_size          numeric(24,6),
  max_size          numeric(24,6),

  -- D5: stamped once at insert, never derived from live policy.
  observed_at       timestamptz not null,
  submitted_at      timestamptz not null,
  valid_from        timestamptz not null,
  expiry_warning_at timestamptz not null,
  valid_until       timestamptz not null,

  superseded_by     uuid references public.rates(id),
  superseded_at     timestamptz,
  withdrawn_at      timestamptz,
  withdrawn_by      uuid references public.principals(id),
  withdrawn_reason  text,
  correction_of     uuid references public.rates(id),
  normalised_from_inverse boolean not null default false,

  -- Tenant consistency enforced by the database, not only by the RPC.
  -- V2 left this to validation inside a privileged function: exactly the
  -- code most likely to be trusted and least likely to be re-checked.
  foreign key (partner_pair_id, partner_id)
    references public.partner_pairs(id, partner_id) on delete restrict,
  foreign key (submission_id, partner_id)
    references public.rate_submissions(id, partner_id) on delete restrict,

  constraint at_least_one_side
    check (partner_bid is not null or partner_ask is not null),
  -- §6.3: a crossed rate is an error, never a warning, and never silently swapped.
  constraint not_crossed
    check (partner_bid is null or partner_ask is null or partner_bid <= partner_ask),
  constraint positive_rates
    check ((partner_bid is null or partner_bid > 0)
       and (partner_ask is null or partner_ask > 0)),
  constraint size_shape
    check ((size_status = 'unconfirmed' and min_size is null and max_size is null)
        or (size_status = 'confirmed'   and min_size is not null
              and (max_size is null or max_size >= min_size))),
  constraint validity_order
    check (valid_from <= expiry_warning_at and expiry_warning_at <= valid_until),
  constraint supersession_pair
    check ((superseded_by is null) = (superseded_at is null)),
  constraint withdrawal_pair
    check ((withdrawn_at is null) = (withdrawn_by is null)),

  -- D16: current confirmed bands for a partner-pair may not overlap.
  -- numrange(min,max,'[]') with a null upper is unbounded above, so a band
  -- with no stated ceiling participates correctly without a sentinel.
  -- DEFERRABLE is what makes the §12.5 insert-then-supersede order executable:
  -- it permits the transient state where old and new rows are both current.
  constraint rates_bands_no_overlap
    exclude using gist (
      partner_pair_id with =,
      numrange(min_size, max_size, '[]') with &&
    ) where (superseded_by is null and withdrawn_at is null and size_status = 'confirmed')
    deferrable initially deferred,

  -- §10.4: at most one current unconfirmed row per partner-pair.
  constraint rates_one_unbanded
    exclude using gist (partner_pair_id with =)
    where (superseded_by is null and withdrawn_at is null and size_status = 'unconfirmed')
    deferrable initially deferred
);

create index rates_current
  on public.rates (partner_pair_id, partner_id)
  where superseded_by is null and withdrawn_at is null;

create index on public.rates (partner_id, partner_pair_id, submitted_at desc);

-- --- §11.6 Markup -----------------------------------------------------
-- Keyed on currency_pair_id so markup and rates reference the same canonical
-- object. The word "tier" appears nowhere, deliberately.
create table public.markup_versions (
  id               uuid primary key default gen_random_uuid(),
  currency_pair_id uuid not null references public.currency_pairs(id) on delete restrict,
  default_bps      numeric(10,4) not null check (default_bps >= 0),
  min_bps          numeric(10,4) not null check (min_bps >= 0),
  max_bps          numeric(10,4) not null,
  status           text not null default 'active'
                     check (status in ('active','retired')),
  reason           text not null,
  created_by       uuid not null references public.principals(id),
  created_at       timestamptz not null default now(),
  retired_by       uuid references public.principals(id),
  retired_at       timestamptz,
  supersedes       uuid references public.markup_versions(id),
  constraint bps_band check (min_bps <= default_bps and default_bps <= max_bps),
  constraint retired_shape
    check (status <> 'retired' or (retired_at is not null and retired_by is not null))
);
create unique index markup_one_active
  on public.markup_versions (currency_pair_id) where status = 'active';

-- --- §11.7 Audit: append-only ----------------------------------------
create table public.audit_events (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),
  actor_id     uuid references public.principals(id),
  actor_email  extensions.citext,
  actor_role   text,
  action       text not null,
  subject_type text not null,
  subject_id   text not null,
  partner_id   uuid references public.partners(id),
  -- §18.4: structured keys only. Never a rendered sentence containing an address.
  detail       jsonb not null default '{}'::jsonb,
  request_ip   inet
);
create index on public.audit_events (occurred_at desc);
create index on public.audit_events (partner_id, occurred_at desc);
create index on public.audit_events (action, occurred_at desc);
