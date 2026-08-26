'use server';

import { revalidatePath } from 'next/cache';
import { supabaseServer } from '@/lib/supabase/server';

export interface SubmitRow {
  currency_pair_id: string;
  bid: string | null;
  ask: string | null;
  size_status: 'confirmed' | 'unconfirmed';
  min_size: string | null;
  max_size: string | null;
  normalised_from_inverse: boolean;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
  submissionId?: string;
  rows?: Array<{ ord: number; rate_id: string; state: 'new' | 'updated' | 'renewed' }>;
  validUntil?: string;
}

/**
 * §6.4 atomicity: submit_rates either stores every confirmed row or none.
 *
 * §16.1 "Submit fails": the grid keeps every value entered. That is why this
 * returns an error string rather than throwing or redirecting — the client
 * holds its state and shows the message above it. "A failed submission MUST
 * NOT clear work."
 */
export async function submitRates(
  rows: SubmitRow[],
  validUntil: string | null,
  raw: string | null,
  idempotencyKey: string | null,
): Promise<SubmitResult> {
  const sb = await supabaseServer();

  const { data, error } = await sb.rpc('submit_rates', {
    p_rows: rows,
    p_valid_until: validUntil,
    p_raw: raw,
    p_idem: idempotencyKey,
  });

  if (error) {
    // §9 / §18.2, and F10's resolution.
    //
    // submit_rates has already RAISED and rolled back — §6.4 makes the batch
    // atomic, so there is no envelope and no error_count to read. Without this
    // second, separate call the attempt leaves no trace at all, and a partner
    // bouncing off validation is invisible to backbone. §2 names that as the
    // risk that decides the outcome: "a partner hitting errors silently stops
    // using the product".
    //
    // It is a distinct transaction, which is exactly why it survives the
    // rollback. Deliberately best-effort: if the log write fails, the partner
    // still gets their error. A telemetry failure must never mask the thing it
    // was recording.
    try {
      await sb.rpc('record_submission_failure', {
        p_reason: error.message,
        p_sqlstate: error.code ?? null,
        p_row_count: rows.length,
      });
    } catch {
      // Swallowed on purpose — see above.
    }
    return { ok: false, error: error.message };
  }

  const result = data as {
    submission_id: string;
    valid_until: string;
    rows: Array<{ ord: number; rate_id: string; state: 'new' | 'updated' | 'renewed' }>;
  };

  revalidatePath('/partner');
  revalidatePath('/partner/history');

  return {
    ok: true,
    submissionId: result.submission_id,
    rows: result.rows,
    validUntil: result.valid_until,
  };
}
