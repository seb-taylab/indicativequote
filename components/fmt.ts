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

export function band(sizeStatus: string, min: string | null, max: string | null): string {
  if (sizeStatus === 'unconfirmed') return 'not confirmed';
  const lo = min ?? '0';
  return max ? `${lo} – ${max}` : `${lo} and above`;
}
