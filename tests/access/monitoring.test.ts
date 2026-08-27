/**
 * §18.2 monitoring signals.
 *
 * §18.2 is a seven-row table of signals, thresholds and actions. Exactly one
 * row had been implemented -- the purge job's 25-hour check, in 0024. The rest
 * existed only in the document.
 *
 * The row these tests care about most is sign-in denials. §19/TM12 makes the
 * sign-in response byte-identical whether an address is known, unknown or
 * revoked. That is the correct defence against enumeration (TM12) and it also
 * means an enumeration attempt is INVISIBLE from the application by design.
 * §18.2's "more than 10 denials in ten minutes" is the compensating control.
 * Untested, the compensating control is an assumption, and the byte-identical
 * response is a blindfold rather than a defence.
 *
 * The threshold assertions here deliberately test BOTH SIDES of the boundary.
 * F24 and N7 were both cases of an assertion that would have passed whatever
 * the code did; a breach test that only ever checks the breached state cannot
 * tell a working threshold from one hard-coded to true.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, signInAs } from '../helpers/clients';
import { F, buildWorld, teardown, type World } from '../helpers/fixtures';
import { closeDb, q } from '../helpers/db';

let world: World;
let operator: SupabaseClient;
let admin: SupabaseClient;
let partnerA: SupabaseClient;
let rm: SupabaseClient;

/** Denials written directly, so the threshold is exercised without spraying
 *  magic links at a real mailer. The RPC reads audit_events either way. */
async function writeDenials(count: number, minutesAgo = 1) {
  for (let i = 0; i < count; i += 1) {
    await q(
      `insert into public.audit_events (action, subject_type, subject_id, detail, occurred_at)
       values ('access.signin_denied', 'email', $1,
               jsonb_build_object('reason', 'unknown'),
               now() - make_interval(mins => $2::int))`,
      [`enumeration.probe.${i}@example.com`, minutesAgo],
    );
  }
}

async function clearDenials() {
  await q(
    `delete from public.audit_events
      where action = 'access.signin_denied'
        and subject_id like 'enumeration.probe.%'`,
  );
}

type Signal = {
  key: string;
  label: string;
  threshold: string;
  action: string;
  observable: boolean;
  value?: number | string | null;
  breached?: boolean;
  note?: string;
};

async function signals(client: SupabaseClient): Promise<Signal[]> {
  const { data, error } = await client.rpc('monitoring_signals');
  if (error) throw new Error(error.message);
  return data as unknown as Signal[];
}

beforeAll(async () => {
  world = await buildWorld();
  operator = await signInAs(F.users.operator);
  admin = await signInAs(F.users.admin);
  partnerA = await signInAs(F.users.aAdmin);
  rm = await signInAs(F.users.rm);
  await clearDenials();
});

afterAll(async () => {
  await clearDenials();
  await teardown();
  await closeDb();
});

describe('§18.2 -- who may read the monitoring signals', () => {
  it('lets a backbone operator read them', async () => {
    expect((await signals(operator)).length).toBeGreaterThan(0);
  });

  it('lets a backbone admin read them', async () => {
    expect((await signals(admin)).length).toBeGreaterThan(0);
  });

  it('refuses a partner (TM1 -- this counts partner failures by name)', async () => {
    const { error } = await partnerA.rpc('monitoring_signals');
    expect(error, 'a partner read the monitoring signals').not.toBeNull();
  });

  it('refuses an RM -- §4 gives read of the board, not of operations', async () => {
    const { error } = await rm.rpc('monitoring_signals');
    expect(error, 'an RM read the monitoring signals').not.toBeNull();
  });

  it('refuses an anonymous caller', async () => {
    const { error } = await anonClient().rpc('monitoring_signals');
    expect(error, 'anon read the monitoring signals').not.toBeNull();
  });
});

describe('§18.2 -- every row of the table is present', () => {
  it('returns all seven signals, not just the ones the database can answer', async () => {
    const keys = (await signals(operator)).map((s) => s.key).sort();
    expect(keys).toEqual(
      [
        'advisory_lock_wait',
        'board_latency',
        'purge_job',
        'rpc_errors',
        'signin_denials',
        'stale_pairs',
        'submission_failures',
      ].sort(),
    );
  });

  it('marks the two measured at the edge as not observable, and says where', async () => {
    // Omitting them would make a panel showing five of seven read as "all
    // clear". N8's rule: a check that silently does not run is worse than one
    // that fails, because green looks the same either way.
    const notHere = (await signals(operator)).filter((s) => !s.observable);
    expect(notHere.map((s) => s.key).sort()).toEqual(['board_latency', 'rpc_errors']);
    for (const s of notHere) {
      expect(s.note, `${s.key} is not observable but names no source`).toBeTruthy();
      expect(s.value ?? null, `${s.key} reports a value it cannot know`).toBeNull();
    }
  });

  it('states a threshold and an action for every signal', async () => {
    for (const s of await signals(operator)) {
      expect(s.threshold, `${s.key} has no threshold`).toBeTruthy();
      expect(s.action, `${s.key} has no action`).toBeTruthy();
    }
  });
});

describe('§18.2 -- the sign-in denial threshold (TM12 compensating control)', () => {
  it('is not breached when nothing is happening', async () => {
    await clearDenials();
    const s = (await signals(operator)).find((x) => x.key === 'signin_denials')!;
    expect(s.value).toBe(0);
    expect(s.breached).toBe(false);
  });

  it('is NOT breached at exactly ten -- the threshold is "more than 10"', async () => {
    await clearDenials();
    await writeDenials(10);
    const s = (await signals(operator)).find((x) => x.key === 'signin_denials')!;
    expect(s.value).toBe(10);
    expect(s.breached, 'ten denials tripped a "more than 10" threshold').toBe(false);
  });

  it('is breached at eleven', async () => {
    await clearDenials();
    await writeDenials(11);
    const s = (await signals(operator)).find((x) => x.key === 'signin_denials')!;
    expect(s.value).toBe(11);
    expect(s.breached).toBe(true);
  });

  it('counts only the last ten minutes', async () => {
    // Twenty denials from an hour ago are history, not an incident in
    // progress. A window that does not actually slide would alert forever
    // after one bad afternoon, and an alert that never clears is ignored.
    await clearDenials();
    await writeDenials(20, 60);
    const s = (await signals(operator)).find((x) => x.key === 'signin_denials')!;
    expect(s.value).toBe(0);
    expect(s.breached).toBe(false);
  });
});

describe('§18.2 -- the submission-failure threshold is per partner', () => {
  it('does not breach on two failures for one partner', async () => {
    await q(`delete from public.submission_failures`);
    await q(
      `insert into public.submission_failures (partner_id, principal_id, reason, row_count)
       select $1, null, 'test', 1 from generate_series(1, 2)`,
      [world.partnerAId],
    );
    const s = (await signals(operator)).find((x) => x.key === 'submission_failures')!;
    expect(s.value).toBe(2);
    expect(s.breached, 'two failures tripped a "more than 2" threshold').toBe(false);
  });

  it('breaches on three for one partner', async () => {
    await q(`delete from public.submission_failures`);
    await q(
      `insert into public.submission_failures (partner_id, principal_id, reason, row_count)
       select $1, null, 'test', 1 from generate_series(1, 3)`,
      [world.partnerAId],
    );
    const s = (await signals(operator)).find((x) => x.key === 'submission_failures')!;
    expect(s.value).toBe(3);
    expect(s.breached).toBe(true);
  });

  it('does NOT breach on two failures each across two partners', async () => {
    // Four failures in total, no partner above the threshold. §18.2 says "for
    // one partner" precisely because the per-partner shape is the signal: two
    // partners mistyping once each is not one partner about to give up.
    await q(`delete from public.submission_failures`);
    await q(
      `insert into public.submission_failures (partner_id, principal_id, reason, row_count)
       select $1, null, 'test', 1 from generate_series(1, 2)`,
      [world.partnerAId],
    );
    await q(
      `insert into public.submission_failures (partner_id, principal_id, reason, row_count)
       select $1, null, 'test', 1 from generate_series(1, 2)`,
      [world.partnerBId],
    );
    const s = (await signals(operator)).find((x) => x.key === 'submission_failures')!;
    expect(s.value, 'the maximum is per partner, not a total').toBe(2);
    expect(s.breached).toBe(false);
    await q(`delete from public.submission_failures`);
  });
});

describe('§18.2 -- the retention purge job', () => {
  it('reports the last run and is not overdue once it has run', async () => {
    // The scheduled job had never actually fired when this was written: the
    // cron entry existed and its first 03:17 UTC had not come round. A job
    // that has never run is a belief, which is §18.3's point about backups
    // applied one layer down. Running it once proves the path.
    await q(`select app.run_raw_input_purge(90)`);
    const s = (await signals(operator)).find((x) => x.key === 'purge_job')!;
    expect(s.value, 'the purge job reports no last run').toBeTruthy();
    expect(s.breached).toBe(false);
  });

  it('purges nothing that is not yet 90 days old', async () => {
    // §18.4 retains raw_input for 90 days. This project is days old, so a
    // correct purge nulls nothing -- and a purge that nulled recent rows
    // would destroy the dispute-resolution record §18.4 exists to keep.
    const [before] = await q<{ n: number }>(
      `select count(*)::int as n from public.rate_submissions where raw_input is not null`,
    );
    await q(`select app.run_raw_input_purge(90)`);
    const [after] = await q<{ n: number }>(
      `select count(*)::int as n from public.rate_submissions where raw_input is not null`,
    );
    expect(after!.n).toBe(before!.n);
  });
});
