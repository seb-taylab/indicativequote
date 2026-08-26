'use server';

import { supabaseServer } from '@/lib/supabase/server';

/**
 * §8: "The client sends only rate_id, direction, amount and markup_bps."
 *
 * There is no price parameter here and none in record_quote_copy. The server
 * recomputes from the stored rate and the active markup version, and returns
 * the finished text. The browser never assembles the wording.
 */
export interface CopyResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export async function copyQuote(
  rateId: string,
  direction: string,
  amount: string | null,
  markupBps: string | null,
): Promise<CopyResult> {
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('record_quote_copy', {
    p_rate_id: rateId,
    p_direction: direction,
    p_amount: amount,
    p_markup_bps: markupBps,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, text: (data as { quote_text: string }).quote_text };
}
