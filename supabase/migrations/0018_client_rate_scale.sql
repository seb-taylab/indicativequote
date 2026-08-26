-- =====================================================================
-- 0018  Round the client rate to the storage scale
--
-- app.client_rate returned numeric arithmetic at full working scale, e.g.
--   1393.50000000000000000000000000000000000000   (40 dp)
--
-- rates.partner_bid/ask are numeric(28,14), so anything beyond 14 dp is
-- spurious precision, not accuracy. Not a correctness bug -- the value is
-- right -- but §12.7 sends these across the wire as TEXT for a person to read,
-- and 40 digits invites someone downstream to "tidy it up" with a float, which
-- is precisely the failure §12.7 exists to prevent.
--
-- Rounded at the single place the rate is computed, so board_rates and
-- record_quote_copy cannot disagree.
-- =====================================================================

create or replace function app.client_rate(
  p_bid numeric, p_ask numeric, p_direction text, p_markup_bps numeric
) returns numeric
language sql immutable set search_path = ''
as $$
  select round(
    case app.side_for_direction(p_direction)
      when 'bid' then p_bid * (1 - p_markup_bps / 10000)
      when 'ask' then p_ask * (1 + p_markup_bps / 10000)
    end, 14)
$$;
