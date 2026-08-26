-- =====================================================================
-- 0023  Views emit decimals as text
-- Spec §12.7, D13, §11.8. See docs/spec-findings.md F15.
--
-- RECONSTRUCTED FROM THE LIVE DATABASE, for the same reason as 0022 -- and
-- this one matters more. Without this file a rebuild would restore §11.8's
-- view returning numeric, and PostgREST would serialise every rate as a JSON
-- number for JavaScript to parse as a binary double. That is F15 verbatim: a
-- partner's own rates losing precision on the way to the browser, with no
-- float anywhere in the schema.
--
-- Column names and the exposed set are unchanged from §11.8; only the wire
-- type changes. v_rate_history additionally carries the superseded, corrected
-- and withdrawn rows that v_current_rates excludes by definition, for §5's
-- read-only submission history.
-- =====================================================================

drop view if exists public.v_current_rates;

create view public.v_current_rates
with (security_invoker = true) as
 SELECT r.id,
    r.partner_id,
    r.partner_pair_id,
    r.partner_bid::text AS partner_bid,
    r.partner_ask::text AS partner_ask,
    r.size_status,
    r.min_size::text AS min_size,
    r.max_size::text AS max_size,
    r.observed_at,
    r.submitted_at,
    r.valid_from,
    r.expiry_warning_at,
    r.valid_until,
    r.normalised_from_inverse,
    r.correction_of,
    p.slug AS partner_slug,
    p.display_name AS partner_name,
    pp.quote_mode,
    cp.id AS currency_pair_id,
    cp.base_ccy,
    cp.quote_ccy,
        CASE
            WHEN p.status <> 'active'::text OR pp.active = false OR p.convention_confirmed_at IS NULL THEN 'unavailable'::text
            WHEN now() >= r.valid_until THEN 'expired'::text
            WHEN now() >= r.expiry_warning_at THEN 'expiring'::text
            ELSE 'live'::text
        END AS status
   FROM rates r
     JOIN partners p ON p.id = r.partner_id
     JOIN partner_pairs pp ON pp.id = r.partner_pair_id
     JOIN currency_pairs cp ON cp.id = pp.currency_pair_id
  WHERE r.superseded_by IS NULL AND r.withdrawn_at IS NULL;

create or replace view public.v_rate_history
with (security_invoker = true) as
 SELECT r.id,
    r.partner_id,
    r.partner_pair_id,
    r.submission_id,
    r.partner_bid::text AS partner_bid,
    r.partner_ask::text AS partner_ask,
    r.size_status,
    r.min_size::text AS min_size,
    r.max_size::text AS max_size,
    r.observed_at,
    r.submitted_at,
    r.valid_from,
    r.expiry_warning_at,
    r.valid_until,
    r.superseded_at,
    r.withdrawn_at,
    r.withdrawn_reason,
    r.correction_of,
    r.normalised_from_inverse,
    cp.base_ccy,
    cp.quote_ccy,
        CASE
            WHEN r.withdrawn_at IS NOT NULL THEN 'withdrawn'::text
            WHEN r.superseded_at IS NOT NULL THEN 'superseded'::text
            WHEN now() >= r.valid_until THEN 'expired'::text
            ELSE 'current'::text
        END AS lifecycle
   FROM rates r
     JOIN partner_pairs pp ON pp.id = r.partner_pair_id
     JOIN currency_pairs cp ON cp.id = pp.currency_pair_id;

grant select on public.v_current_rates, public.v_rate_history to authenticated;
