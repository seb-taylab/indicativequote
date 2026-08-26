import { requireStaff } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { sgt } from '@/components/fmt';
import { AuditRow } from './AuditRow';

export const dynamic = 'force-dynamic';

const ACTIONS = [
  'rate.submit', 'rate.renew', 'rate.correct', 'rate.withdraw',
  'pair.add', 'pair.deactivate', 'pair.reactivate', 'pair.set_mode',
  'partner.create', 'partner.deactivate', 'partner.activate',
  'partner.set_policy', 'partner.confirm_convention',
  'access.invite', 'access.revoke', 'access.set_role',
  'access.signin', 'access.signin_denied',
  'markup.create', 'markup.retire', 'quote.copy',
  'registry.add_pair', 'registry.add_currency',
];

/**
 * §16.3 /admin/audit: reverse-chronological, filterable by action, partner,
 * actor and date range. Every row expandable to its `detail`. Read-only, with
 * no export in the MVP.
 *
 * Ordered by (occurred_at desc, id desc). occurred_at is transaction start
 * time, so events written by one RPC share it and id is the only tiebreaker --
 * see docs/spec-findings.md F7.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; partner?: string; from?: string; to?: string }>;
}) {
  const principal = await requireStaff(['backbone_operator', 'backbone_admin']);
  const sp = await searchParams;
  const sb = await supabaseServer();

  let query = sb
    .from('audit_events')
    .select('id, occurred_at, actor_email, actor_role, action, subject_type, subject_id, partner_id, detail')
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(200);

  if (sp.action) query = query.eq('action', sp.action);
  if (sp.partner) query = query.eq('partner_id', sp.partner);
  if (sp.from) query = query.gte('occurred_at', new Date(sp.from).toISOString());
  if (sp.to) query = query.lte('occurred_at', new Date(`${sp.to}T23:59:59`).toISOString());

  const [{ data: events }, { data: partners }] = await Promise.all([
    query,
    sb.from('partners').select('id, display_name').order('display_name'),
  ]);

  return (
    <AppShell principal={principal} title="Audit">
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="action" className="block text-xs font-medium">Action</label>
          <select id="action" name="action" defaultValue={sp.action ?? ''}
                  className="mt-1 rounded border px-2 py-1.5"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
            <option value="">All</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="partner" className="block text-xs font-medium">Partner</label>
          <select id="partner" name="partner" defaultValue={sp.partner ?? ''}
                  className="mt-1 rounded border px-2 py-1.5"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
            <option value="">All</option>
            {(partners ?? []).map((p) => (
              <option key={p.id as string} value={p.id as string}>{p.display_name as string}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="block text-xs font-medium">From</label>
          <input id="from" name="from" type="date" defaultValue={sp.from ?? ''}
                 className="num mt-1 rounded border px-2 py-1.5"
                 style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
        </div>
        <div>
          <label htmlFor="to" className="block text-xs font-medium">To</label>
          <input id="to" name="to" type="date" defaultValue={sp.to ?? ''}
                 className="num mt-1 rounded border px-2 py-1.5"
                 style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
        </div>
        <button type="submit" className="rounded px-3 py-1.5 text-sm font-medium text-white"
                style={{ background: 'var(--accent)' }}>
          Filter
        </button>
        <a href="/admin/audit" className="text-sm" style={{ color: 'var(--accent)' }}>Clear</a>
      </form>

      {(events ?? []).length === 0 ? (
        <p className="mt-6 text-sm" style={{ color: 'var(--muted)' }}>
          No audit events match those filters.
        </p>
      ) : (
        <div className="table-scroll mt-4">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr style={{ borderBottom: `2px solid var(--border)` }}>
                <th scope="col" className="px-2 py-2 text-left">When</th>
                <th scope="col" className="px-2 py-2 text-left">Actor</th>
                <th scope="col" className="px-2 py-2 text-left">Role</th>
                <th scope="col" className="px-2 py-2 text-left">Action</th>
                <th scope="col" className="px-2 py-2 text-left">Subject</th>
                <th scope="col" className="px-2 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map((e) => (
                <AuditRow
                  key={String(e.id)}
                  when={sgt(e.occurred_at as string)}
                  actor={(e.actor_email as string) ?? 'system'}
                  role={(e.actor_role as string) ?? '—'}
                  action={e.action as string}
                  subject={`${e.subject_type}:${String(e.subject_id).slice(0, 8)}`}
                  detail={JSON.stringify(e.detail, null, 2)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
        Append-only and read-only. No role can update or delete an audit event, and there is no
        export in this release. Most recent 200 shown.
      </p>
    </AppShell>
  );
}
