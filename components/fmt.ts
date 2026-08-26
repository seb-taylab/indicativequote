/**
 * Display helpers. A-3: UTC storage, SGT display.
 *
 * Nothing here parses a rate. Rates arrive as strings (§12.7) and are rendered
 * as strings; only timestamps are converted, and a timestamp is not a decimal.
 */

const SGT: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Singapore',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

export function sgt(iso: string | null): string {
  if (!iso) return '—';
  return `${new Intl.DateTimeFormat('en-GB', SGT).format(new Date(iso))} SGT`;
}

export function sgtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(iso));
}

/** Relative age, for §7's "amber row treatment plus relative age". */
export function age(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Trim a decimal STRING for display, without ever touching Number().
 *
 * Rates are stored at numeric(28,14) and cross the wire as text (§12.7), so a
 * live rate arrives as "1501.50000000000000". Fourteen trailing zeros on the
 * RM's primary screen are not precision, they are noise -- §7 requires the
 * board to answer the question without scrolling, and a column of 18-character
 * numbers works against that.
 *
 * This is pure string surgery: it removes trailing zeros in the fractional
 * part and the point if nothing survives it. No parsing, no rounding, no loss.
 * The full-precision value stays in the payload; only the rendering changes.
 */
export function dec(value: string | null, opts?: { group?: boolean; minDp?: number }): string {
  if (value === null || value === undefined || value === '') return '—';

  // §12.7 tripwire. A `number` here means a decimal reached JavaScript as a
  // binary double -- almost always a numeric column read straight through
  // PostgREST without a ::text cast. By this point precision is ALREADY LOST,
  // so coercing with String(value) would render a corrupted figure and hide
  // the cause forever.
  //
  // This is exactly how the partner pages broke: they read v_current_rates
  // directly while every RPC was casting to text. Failing loudly is the only
  // behaviour that keeps D13 true, so this throws and names the fix.
  if (typeof value !== 'string') {
    throw new TypeError(
      `dec() received a ${typeof value}, not a string. A decimal has crossed the ` +
        `wire as a JSON number and its precision is already gone (§12.7/D13). ` +
        `Cast the column to ::text in the view or RPC that produced it.`,
    );
  }

  const neg = value.startsWith('-');
  const body = neg ? value.slice(1) : value;
  const [intPartRaw, fracRaw = ''] = body.split('.');
  let intPart = intPartRaw ?? '0';
  let frac = fracRaw.replace(/0+$/, '');

  const minDp = opts?.minDp ?? 0;
  while (frac.length < minDp) frac += '0';

  if (opts?.group) {
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
}

/** A size bound: grouped and trimmed, because these are round human numbers. */
export function size(value: string | null): string {
  return dec(value, { group: true });
}

export function band(sizeStatus: string, min: string | null, max: string | null): string {
  if (sizeStatus === 'unconfirmed') return 'not confirmed';
  const lo = size(min ?? '0');
  return max ? `${lo} – ${size(max)}` : `${lo} and above`;
}
