/**
 * The shape board_rates returns. Every decimal is a STRING (§12.7) and must
 * stay one: no Number(), no parseFloat, no arithmetic on primitives.
 */
export interface BoardRow {
  rate_id: string;
  partner_name: string;
  partner_slug: string;
  partner_bid: string | null;
  partner_ask: string | null;
  spread: string | null;
  size_status: 'confirmed' | 'unconfirmed';
  min_size: string | null;
  max_size: string | null;
  observed_at: string;
  submitted_at: string;
  valid_until: string;
  status: 'live' | 'expiring' | 'expired';
  source: 'submitted' | 'normalised' | 'correction';
  markup_bps: string | null;
  client_rate: string | null;
  counter_amount: string | null;
  rank?: number;
  reason?: string;
}

export interface MarkupVersion {
  id: string;
  default_bps: string;
  min_bps: string;
  max_bps: string;
}

export interface BoardResult {
  currency_pair: { id: string; base_ccy: string; quote_ccy: string };
  direction: 'client_sells_base' | 'client_buys_base';
  side_used: 'bid' | 'ask';
  amount: string | null;
  amount_header: string;
  markup_bps: string | null;
  markup_version: MarkupVersion | null;
  rankable: boolean;
  eligible: BoardRow[];
  ineligible: BoardRow[];
  withheld_count: number;
}

export interface PairOption {
  id: string;
  base_ccy: string;
  quote_ccy: string;
}
