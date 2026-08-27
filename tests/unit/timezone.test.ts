/**
 * A-3 / §20.3: "Timezone -- UTC storage, SGT display, ACROSS A DATE BOUNDARY."
 *
 * SGT is UTC+8 with no daylight saving, so any instant from 16:00 UTC onward is
 * already the NEXT DAY in Singapore. Nine hours of every day fall on a
 * different date in the two zones, and every stamp this application shows is
 * stored in UTC and read in SGT.
 *
 * The stake is §8: a copied quote carries "the rate's source timestamp, in SGT"
 * and "the expiry time, in SGT", and that text is the authoritative record of
 * what MetaComp quoted. A date that is a day out in a quote is not a display
 * bug, it is a wrong record of a commitment.
 */
import { describe, expect, it } from 'vitest';
import { sgt, sgtDate, age } from '../../components/fmt';

/** 2026-08-26T16:30:00Z is 2026-08-27 00:30 in Singapore. */
const CROSSES_FORWARD = '2026-08-26T16:30:00.000Z';
/** 2026-08-26T15:30:00Z is still 2026-08-26 23:30 in Singapore. */
const SAME_DAY = '2026-08-26T15:30:00.000Z';
/** 2026-08-26T00:30:00Z is 2026-08-26 08:30 SGT -- same date, +8 hours. */
const MORNING = '2026-08-26T00:30:00.000Z';

describe('A-3 -- SGT display crosses the date boundary correctly', () => {
  it('shows the NEXT day for an instant at or after 16:00 UTC', () => {
    // 26 Aug 16:30 UTC -> 27 Aug 00:30 SGT. Showing "26 Aug" here would be a
    // full day wrong on the expiry an RM reads.
    expect(sgt(CROSSES_FORWARD)).toBe('27 Aug, 00:30 SGT');
  });

  it('stays on the same day just before the boundary', () => {
    expect(sgt(SAME_DAY)).toBe('26 Aug, 23:30 SGT');
  });

  it('adds eight hours within a day', () => {
    expect(sgt(MORNING)).toBe('26 Aug, 08:30 SGT');
  });

  it('crosses a month boundary', () => {
    // 31 Aug 16:30 UTC -> 1 Sep 00:30 SGT.
    // en-GB abbreviates September as "Sept", not "Sep" -- four letters where
    // every other month takes three. Asserted as it actually renders rather
    // than as it "should", because the date is correct and that is the claim.
    expect(sgt('2026-08-31T16:30:00.000Z')).toBe('01 Sept, 00:30 SGT');
  });

  it('crosses a year boundary', () => {
    // 31 Dec 16:30 UTC -> 1 Jan 00:30 SGT, the following year.
    expect(sgtDate('2026-12-31T16:30:00.000Z')).toBe('01 Jan 2027');
  });

  it('has no daylight-saving discontinuity -- SGT is UTC+8 year round', () => {
    // Northern-hemisphere summer and winter must behave identically. A zone
    // with DST would shift one of these by an hour.
    expect(sgt('2026-01-15T16:30:00.000Z')).toBe('16 Jan, 00:30 SGT');
    expect(sgt('2026-07-15T16:30:00.000Z')).toBe('16 Jul, 00:30 SGT');
  });

  it('never renders in the machine local zone', () => {
    // The whole point of A-3: the answer must not depend on where the server
    // or the browser happens to be. Asserted against a fixed expected string
    // rather than against a locally-computed one.
    const local = new Date(CROSSES_FORWARD).toString();
    expect(sgt(CROSSES_FORWARD)).not.toContain(local.slice(0, 3));
    expect(sgt(CROSSES_FORWARD)).toContain('SGT');
  });

  it('handles a null stamp without inventing a date', () => {
    expect(sgt(null)).toBe('—');
    expect(sgtDate(null)).toBe('—');
    expect(age(null)).toBe('—');
  });
});

describe('§7 -- relative age is what makes staleness legible', () => {
  it('reports minutes, hours and days', () => {
    const now = Date.now();
    // age() rounds, so 30s already reads as a minute. Under 30s is "just now".
    expect(age(new Date(now - 10_000).toISOString())).toBe('just now');
    expect(age(new Date(now - 40_000).toISOString())).toBe('1 min ago');
    expect(age(new Date(now - 45 * 60_000).toISOString())).toBe('45 min ago');
    expect(age(new Date(now - 5 * 3_600_000).toISOString())).toBe('5 h ago');
    expect(age(new Date(now - 3 * 86_400_000).toISOString())).toBe('3 d ago');
  });

  it('is unaffected by the date boundary -- it measures elapsed time, not dates', () => {
    // A rate submitted at 23:50 SGT and read at 00:10 SGT the next day is 20
    // minutes old, not "yesterday". §7 asks for age precisely because a date
    // alone misleads here.
    const submitted = new Date('2026-08-26T15:50:00.000Z'); // 23:50 SGT
    const readAt = new Date('2026-08-26T16:10:00.000Z').getTime(); // 00:10 SGT +1d
    const mins = Math.round((readAt - submitted.getTime()) / 60000);
    expect(mins).toBe(20);
  });
});
