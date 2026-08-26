-- =====================================================================
-- 0003  Identity (§11.3) and partner pairs (§11.4)
--
-- D11: a principal is staff or partner, never both, and a partner
-- principal belongs to exactly one partner. Enforced structurally:
--   * one address is one principal globally  -> citext unique on email
--   * one principal, at most one partner     -> principal_id is the PK
--   * class exclusivity                      -> kind check + composite FK
-- =====================================================================

create table public.principals (
  id            uuid primary key default gen_random_uuid(),
  email         extensions.citext not null unique,
  kind          text not null check (kind in ('staff','partner')),
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  status        text not null default 'invited'
                  check (status in ('invited','active','revoked')),
  invited_at    timestamptz not null default now(),
  invited_by    uuid,
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  constraint revoked_has_stamp
    check (status <> 'revoked' or (revoked_at is not null and revoked_by is not null))
);
-- Target for the composite foreign keys below; this is what makes a staff
-- principal structurally incapable of holding a partner membership.
create unique index principals_id_kind on public.principals (id, kind);

create table public.staff_profiles (
  principal_id uuid primary key references public.principals(id) on delete restrict,
  kind         text not null default 'staff' check (kind = 'staff'),
  role         text not null
                 check (role in ('rm_viewer','backbone_operator','backbone_admin')),
  foreign key (principal_id, kind) references public.principals(id, kind)
);

create table public.partner_memberships (
  principal_id uuid primary key references public.principals(id) on delete restrict,
  kind         text not null default 'partner' check (kind = 'partner'),
  partner_id   uuid not null references public.partners(id) on delete restrict,
  role         text not null default 'partner_user'
                 check (role in ('partner_user','partner_admin')),
  foreign key (principal_id, kind) references public.principals(id, kind)
);
create index on public.partner_memberships (partner_id);

-- --- §11.4 Partner pairs ---------------------------------------------
-- quote_mode lives here and ONLY here. V2 duplicated it on partners with
-- no defined precedence and no setter.
create table public.partner_pairs (
  id               uuid primary key default gen_random_uuid(),
  partner_id       uuid not null references public.partners(id) on delete restrict,
  currency_pair_id uuid not null references public.currency_pairs(id) on delete restrict,
  active           boolean not null default true,
  quote_mode       text not null default 'two_way'
                     check (quote_mode in ('two_way','bid_only','ask_only','either_side')),
  added_at         timestamptz not null default now(),
  added_by         uuid,
  deactivated_at   timestamptz,
  deactivated_by   uuid,
  unique (partner_id, currency_pair_id),
  constraint partner_pairs_id_partner unique (id, partner_id)   -- tenant FK target
);
create index on public.partner_pairs (partner_id) where active;
