import { requireStaff } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { ActionForm, Field } from '@/components/ActionForm';
import { sgtDate } from '@/components/fmt';
import { createPartner, registerCurrency, registerPair } from '../actions';
import { PartnerRow } from './PartnerRow';

export const dynamic = 'force-dynamic';

/** §16.3 /admin/partners. */
export default async function PartnersPage() {
  const principal = await requireStaff(['backbone_operator', 'backbone_admin']);
  const isAdmin = principal.staffRole === 'backbone_admin';
  const sb = await supabaseServer();

  const [{ data: partners }, { data: pairCounts }, { data: currencies }, { data: pairs }] =
    await Promise.all([
      sb.from('partners').select('*').order('display_name'),
      sb.from('partner_pairs').select('partner_id, active'),
      sb.from('currencies').select('code').order('code'),
      sb.from('currency_pairs').select('id, base_ccy, quote_ccy').order('base_ccy'),
    ]);

  const counts = new Map<string, number>();
  for (const pp of pairCounts ?? []) {
    if (pp.active) {
      counts.set(pp.partner_id as string, (counts.get(pp.partner_id as string) ?? 0) + 1);
    }
  }

  return (
    <AppShell principal={principal} title="Partners">
      <div className="table-scroll mt-6">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ borderBottom: `2px solid var(--border)` }}>
              <th scope="col" className="px-2 py-2 text-left">Partner</th>
              <th scope="col" className="px-2 py-2 text-left">Slug</th>
              <th scope="col" className="px-2 py-2 text-left">Status</th>
              <th scope="col" className="px-2 py-2 text-right">Active pairs</th>
              <th scope="col" className="px-2 py-2 text-left">Validity policy</th>
              <th scope="col" className="px-2 py-2 text-left">Bid/ask convention</th>
              <th scope="col" className="px-2 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {(partners ?? []).map((p) => (
              <PartnerRow
                key={p.id as string}
                id={p.id as string}
                name={p.display_name as string}
                slug={String(p.slug)}
                status={p.status as string}
                pairCount={counts.get(p.id as string) ?? 0}
                soft={p.soft_ttl_minutes as number}
                hard={p.hard_ttl_minutes as number}
                moveWarn={String(p.move_warn_pct)}
                confirmedAt={p.convention_confirmed_at ? sgtDate(p.convention_confirmed_at as string) : null}
                confirmedRef={(p.convention_ref as string) ?? null}
                canAdmin={isAdmin}
              />
            ))}
          </tbody>
        </table>
      </div>

      {(partners ?? []).length === 0 && (
        <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>
          No partners yet.
        </p>
      )}

      {isAdmin && (
        <div className="mt-10 grid gap-8 lg:grid-cols-3">
          <section className="rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <h2 className="text-sm font-semibold">Create a partner</h2>
            <p className="mb-3 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              A new partner starts with its bid/ask convention <strong>unconfirmed</strong>. Its
              rates will store but never reach the board until an admin confirms the convention
              in writing.
            </p>
            <ActionForm action={createPartner} submitLabel="Create partner">
              <Field label="Display name" name="display_name" required />
              <Field label="Slug" name="slug" required mono hint="Lower case, no spaces." />
              <Field label="Soft TTL (minutes)" name="soft" type="number" defaultValue={120} mono
                     hint="When a rate starts showing as expiring." />
              <Field label="Hard TTL (minutes)" name="hard" type="number" defaultValue={480} mono
                     hint="When it stops being quotable." />
              <Field label="Large-move warning (%)" name="move_warn" defaultValue="5.000" mono />
            </ActionForm>
          </section>

          <section className="rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <h2 className="text-sm font-semibold">Register a currency</h2>
            <p className="mb-3 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              A currency must exist before a pair can reference it.
            </p>
            <ActionForm action={registerCurrency} submitLabel="Register currency">
              <Field label="Code" name="code" required mono hint="Three to six letters." />
              <Field label="Name" name="name" required />
              <Field label="Kind" name="kind" options={[
                { value: 'fiat', label: 'Fiat' },
                { value: 'stablecoin', label: 'Stablecoin' },
              ]} />
              <Field label="Minor units" name="minor_units" type="number" defaultValue={2} mono />
            </ActionForm>
          </section>

          <section className="rounded border p-4" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <h2 className="text-sm font-semibold">Register a canonical pair</h2>
            <p className="mb-3 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              One approved orientation per couple, and it is a judgement, never alphabetical.
              A rate always means units of QUOTE per one unit of BASE. Registering the inverse
              of an existing couple is refused.
            </p>
            <ActionForm action={registerPair} submitLabel="Register pair">
              <Field label="Base currency" name="base" required mono options={
                (currencies ?? []).map((c) => ({ value: String(c.code), label: String(c.code) }))
              } />
              <Field label="Quote currency" name="quote" required mono options={
                (currencies ?? []).map((c) => ({ value: String(c.code), label: String(c.code) }))
              } />
            </ActionForm>
            {(pairs ?? []).length > 0 && (
              <p className="num mt-3 text-xs" style={{ color: 'var(--muted)' }}>
                Registered: {(pairs ?? []).map((p) => `${p.base_ccy}/${p.quote_ccy}`).join(', ')}
              </p>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
