-- =====================================================================
-- Seed data for local and staging. Spec §18.1.
--
-- "Seed data MUST be realistic enough to exercise every state -- live,
--  expiring, expired, withdrawn, superseded, unconfirmed size, banded pair,
--  one-way pair, unconfirmed convention, missing markup -- and obviously fake
--  enough that nobody mistakes it for production pricing."
--
-- Every rate here is deliberately offset far from any real market. USD/NGN
-- seeds around 1500, not the ~1392 the parser tests use, so a screenshot of
-- seed data can never be mistaken for a real partner's book.
--
-- NEVER RUN THIS AGAINST PRODUCTION. It creates auth users with known ids.
-- =====================================================================

do $$
declare
  v_pair_ngn uuid; v_pair_ghs uuid; v_pair_kes uuid;
  pA uuid; pB uuid;
  ppA_ngn uuid; ppA_ghs uuid; ppA_kes uuid; ppB_ngn uuid;
  sub uuid; rid uuid; prev uuid;
  adm uuid; rm uuid; opr uuid; puA uuid; puB uuid;
begin
  if exists (select 1 from public.partners where slug::text not like 'demo-%') then
    raise exception 'refusing to seed: this database holds non-demo partners';
  end if;

  -- --- Reference -----------------------------------------------------
  insert into public.currencies (code, name, kind, minor_units) values
    ('USD','US Dollar','fiat',2),
    ('NGN','Nigerian Naira','fiat',2),
    ('GHS','Ghanaian Cedi','fiat',2),
    ('KES','Kenyan Shilling','fiat',2)
  on conflict (code) do nothing;

  insert into public.currency_pairs (base_ccy, quote_ccy) values ('USD','NGN') returning id into v_pair_ngn;
  insert into public.currency_pairs (base_ccy, quote_ccy) values ('USD','GHS') returning id into v_pair_ghs;
  insert into public.currency_pairs (base_ccy, quote_ccy) values ('USD','KES') returning id into v_pair_kes;

  -- --- Principals ----------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-dead-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demo.admin@example.com','',now(),now(),now(),'{}','{}'),
    ('00000000-dead-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demo.operator@example.com','',now(),now(),now(),'{}','{}'),
    ('00000000-dead-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demo.rm@example.com','',now(),now(),now(),'{}','{}'),
    ('00000000-dead-0000-0000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demo.alpha@example.com','',now(),now(),now(),'{}','{}'),
    ('00000000-dead-0000-0000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demo.beta@example.com','',now(),now(),now(),'{}','{}')
  on conflict (id) do nothing;

  insert into public.principals (email, kind, auth_user_id, status) values
    ('demo.admin@example.com','staff','00000000-dead-0000-0000-000000000001','active') returning id into adm;
  insert into public.principals (email, kind, auth_user_id, status) values
    ('demo.operator@example.com','staff','00000000-dead-0000-0000-000000000002','active') returning id into opr;
  insert into public.principals (email, kind, auth_user_id, status) values
    ('demo.rm@example.com','staff','00000000-dead-0000-0000-000000000003','active') returning id into rm;

  insert into public.staff_profiles (principal_id, role) values
    (adm,'backbone_admin'), (opr,'backbone_operator'), (rm,'rm_viewer');

  -- --- Partners ------------------------------------------------------
  -- Demo Alpha: convention CONFIRMED, so its rates can reach the board.
  insert into public.partners (slug, display_name, convention_confirmed_at, convention_confirmed_by, convention_ref, created_by)
  values ('demo-alpha','Demo Alpha', now() - interval '30 days', adm, 'DEMO-CONF-001', adm)
  returning id into pA;

  -- Demo Beta: convention NOT confirmed. Exercises the [A-1] gate: its rates
  -- store and show as unavailable, and can never rank.
  insert into public.partners (slug, display_name, created_by)
  values ('demo-beta','Demo Beta', adm) returning id into pB;

  insert into public.principals (email, kind, auth_user_id, status) values
    ('demo.alpha@example.com','partner','00000000-dead-0000-0000-000000000004','active') returning id into puA;
  insert into public.principals (email, kind, auth_user_id, status) values
    ('demo.beta@example.com','partner','00000000-dead-0000-0000-000000000005','active') returning id into puB;
  insert into public.partner_memberships (principal_id, partner_id, role) values
    (puA, pA, 'partner_admin'), (puB, pB, 'partner_admin');

  -- --- Partner pairs -------------------------------------------------
  insert into public.partner_pairs (partner_id, currency_pair_id, added_by)
    values (pA, v_pair_ngn, puA) returning id into ppA_ngn;
  -- A ONE-WAY pair: Demo Alpha quotes GHS bid only.
  insert into public.partner_pairs (partner_id, currency_pair_id, quote_mode, added_by)
    values (pA, v_pair_ghs, 'bid_only', puA) returning id into ppA_ghs;
  -- A pair with NO rate at all -> health reports "missing".
  insert into public.partner_pairs (partner_id, currency_pair_id, added_by)
    values (pA, v_pair_kes, puA) returning id into ppA_kes;
  insert into public.partner_pairs (partner_id, currency_pair_id, added_by)
    values (pB, v_pair_ngn, puB) returning id into ppB_ngn;

  -- --- Markup --------------------------------------------------------
  -- USD/NGN and USD/GHS have active markup. USD/KES deliberately has NONE,
  -- so the board exercises E9 "no active markup".
  insert into public.markup_versions (currency_pair_id, default_bps, min_bps, max_bps, status, reason, created_by)
  values (v_pair_ngn, 50, 0, 200, 'active', 'Demo seed: initial band', adm),
         (v_pair_ghs, 75, 25, 150, 'active', 'Demo seed: initial band', adm);

  -- --- Rates ---------------------------------------------------------
  -- Demo Alpha USD/NGN: two BANDED rows, both LIVE.
  insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count, raw_input)
  values (pA, puA, 'manual_grid', 2, 'USD/NGN 1500 | 1502' || chr(10) || 'USD/NGN 1501.5 | 1503.5 above 100k')
  returning id into sub;

  insert into public.rates (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
    size_status, min_size, max_size, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
  values (sub, pA, ppA_ngn, 1500.00, 1502.00, 'confirmed', 0, 100000,
          now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes',
          now() + interval '110 minutes', now() + interval '470 minutes');

  insert into public.rates (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
    size_status, min_size, max_size, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
  values (sub, pA, ppA_ngn, 1501.50, 1503.50, 'confirmed', 100000.000001, null,
          now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes',
          now() + interval '110 minutes', now() + interval '470 minutes');

  -- Demo Alpha USD/GHS: one-way (bid only), EXPIRING -- past the soft window.
  insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count, raw_input)
  values (pA, puA, 'manual_grid', 1, 'USD/GHS 18.40') returning id into sub;
  insert into public.rates (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
    size_status, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
  values (sub, pA, ppA_ghs, 18.40, null, 'unconfirmed',
          now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours',
          now() - interval '1 hour', now() + interval '5 hours');

  -- Demo Beta USD/NGN: a SUPERSEDED row, a WITHDRAWN row, and a current
  -- EXPIRED one with unconfirmed size. Beta's convention is unconfirmed, so
  -- all of it shows as unavailable regardless.
  insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count, raw_input)
  values (pB, puB, 'manual_grid', 1, 'USD/NGN 1498 | 1505') returning id into sub;
  insert into public.rates (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
    size_status, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
  values (sub, pB, ppB_ngn, 1498.00, 1505.00, 'unconfirmed',
          now() - interval '2 days', now() - interval '2 days', now() - interval '2 days',
          now() - interval '46 hours', now() - interval '40 hours')
  returning id into prev;

  insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count, raw_input)
  values (pB, puB, 'manual_grid', 1, 'USD/NGN 1499 | 1504') returning id into sub;
  insert into public.rates (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
    size_status, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until)
  values (sub, pB, ppB_ngn, 1499.00, 1504.00, 'unconfirmed',
          now() - interval '20 hours', now() - interval '20 hours', now() - interval '20 hours',
          now() - interval '18 hours', now() - interval '12 hours')
  returning id into rid;

  update public.rates set superseded_by = rid, superseded_at = now() - interval '20 hours'
   where id = prev;

  -- A withdrawn row, retained in history and gone from the board.
  insert into public.rate_submissions (partner_id, submitted_by, source_type, row_count)
  values (pB, puB, 'manual_grid', 1) returning id into sub;
  insert into public.rates (submission_id, partner_id, partner_pair_id, partner_bid, partner_ask,
    size_status, observed_at, submitted_at, valid_from, expiry_warning_at, valid_until,
    withdrawn_at, withdrawn_by, withdrawn_reason)
  values (sub, pB, ppB_ngn, 1497.00, 1506.00, 'unconfirmed',
          now() - interval '5 hours', now() - interval '5 hours', now() - interval '5 hours',
          now() - interval '3 hours', now() + interval '3 hours',
          now() - interval '1 hour', puB, 'Demo seed: pulled by partner');

  raise notice 'Seeded. Demo Alpha (confirmed) and Demo Beta (unconfirmed convention).';
end $$;
