-- =====================================================================
-- 0002  Reference tables and partners
-- Spec §11.1 (currencies, currency_pairs), §11.2 (partners)
-- =====================================================================

-- --- §11.1 Reference --------------------------------------------------
create table public.currencies (
  code        text primary key
                check (code = upper(code) and length(code) between 3 and 6),
  name        text not null,
  kind        text not null check (kind in ('fiat','stablecoin')),
  minor_units smallint not null default 2 check (minor_units between 0 and 8),
  active      boolean not null default true
);

create table public.currency_pairs (
  id         uuid primary key default gen_random_uuid(),
  base_ccy   text not null references public.currencies(code) on delete restrict,
  quote_ccy  text not null references public.currencies(code) on delete restrict,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint pair_distinct check (base_ccy <> quote_ccy),
  constraint pair_unique   unique (base_ccy, quote_ccy)
);

-- D8: exactly one orientation per currency couple. Which one is a curated
-- human decision, never derived from alphabetical order or ISO codes.
create unique index currency_pairs_no_inverse
  on public.currency_pairs (least(base_ccy, quote_ccy), greatest(base_ccy, quote_ccy));

-- --- §11.2 Partners ---------------------------------------------------
create table public.partners (
  id                      uuid primary key default gen_random_uuid(),
  slug                    extensions.citext not null unique,
  display_name            text not null,
  status                  text not null default 'active'
                            check (status in ('active','inactive')),
  soft_ttl_minutes        integer not null default 120 check (soft_ttl_minutes > 0),
  hard_ttl_minutes        integer not null default 480 check (hard_ttl_minutes > 0),
  move_warn_pct           numeric(6,3) not null default 5.000 check (move_warn_pct > 0),
  -- [A-1] gate. Null means this partner's rates MUST NOT appear as usable
  -- on the board, however current they are. See §11.2, E2.
  convention_confirmed_at timestamptz,
  convention_confirmed_by uuid,
  convention_ref          text,
  created_at              timestamptz not null default now(),
  created_by              uuid,
  constraint ttl_order check (hard_ttl_minutes >= soft_ttl_minutes)
);

comment on column public.partners.convention_confirmed_at is
  '[A-1] gate. Null => rates show as "unavailable - bid/ask convention not confirmed". §11.2, §14 E2.';
