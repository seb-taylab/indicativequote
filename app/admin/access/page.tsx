import { requireStaff } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { AppShell } from '@/components/AppShell';
import { ActionForm, Field } from '@/components/ActionForm';
import { sgt } from '@/components/fmt';
import { invitePartnerUser, inviteStaff } from '../actions';
import { PrincipalRow } from './PrincipalRow';

export const dynamic = 'force-dynamic';

/**
 * §16.3 /admin/access: "grouped by partner, then a staff section. Invite
 * partner user, operator and above. Invite staff, admin only, VISUALLY
 * SEPARATED so the two are not confused."
 *
 * That separation is not cosmetic. TM4: V2's single invite_principal let an
 * operator invite themselves as backbone_admin. The RPCs are now split and the
 * screen mirrors the split, so the dangerous one is never one careless
 * dropdown away from the routine one.
 */
export default async function AccessPage() {
  const principal = await requireStaff(['backbone_operator', 'backbone_admin']);
  const isAdmin = principal.staffRole === 'backbone_admin';
  const sb = await supabaseServer();

  const [{ data: principals }, { data: memberships }, { data: staff }, { data: partners }] =
    await Promise.all([
      sb.from('principals').select('id, email, kind, status, invited_at, first_seen_at, last_seen_at'),
      sb.from('partner_memberships').select('principal_id, partner_id, role'),
      sb.from('staff_profiles').select('principal_id, role'),
      sb.from('partners').select('id, display_name').order('display_name'),
    ]);

  const memberOf = new Map((memberships ?? []).map((m) => [m.principal_id as string, m]));
  const staffOf = new Map((staff ?? []).map((s) => [s.principal_id as string, s]));

  const activeAdmins = (staff ?? []).filter((s) => {
    if (s.role !== 'backbone_admin') return false;
    const p = (principals ?? []).find((x) => x.id === s.principal_id);
    return p?.status === 'active';
  }).length;

  const byPartner = new Map<string, typeof principals>();
  const staffList: NonNullable<typeof principals> = [];

  for (const p of principals ?? []) {
    if (p.kind === 'staff') {
      staffList.push(p);
    } else {
      const m = memberOf.get(p.id as string);
      const key = (m?.partner_id as string) ?? 'unknown';
      const list = byPartner.get(key) ?? [];
      list.push(p);
      byPartner.set(key, list);
    }
  }

  return (
    <AppShell principal={principal} title="Access">
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        Backbone owns all access management. Partner admins cannot invite anyone.
      </p>

      {/* ---- Partner access ---- */}
      <section className="mt-8">
        <h2 className="text-base font-semibold">Partner access</h2>
        {(partners ?? []).map((partner) => {
          const people = byPartner.get(partner.id as string) ?? [];
          return (
            <div key={partner.id as string} className="mt-4">
              <h3 className="text-sm font-medium">{partner.display_name as string}</h3>
              {people.length === 0 ? (
                <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>No one yet.</p>
              ) : (
                <div className="table-scroll mt-1">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr style={{ borderBottom: `1px solid var(--border)` }}>
                        <th scope="col" className="px-2 py-1 text-left">E-mail</th>
                        <th scope="col" className="px-2 py-1 text-left">Role</th>
                        <th scope="col" className="px-2 py-1 text-left">Invited</th>
                        <th scope="col" className="px-2 py-1 text-left">First sign-in</th>
                        <th scope="col" className="px-2 py-1 text-left">Last sign-in</th>
                        <th scope="col" className="px-2 py-1 text-left">Status</th>
                        <th scope="col" className="px-2 py-1"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((p) => (
                        <PrincipalRow
                          key={p.id as string}
                          id={p.id as string}
                          email={String(p.email)}
                          kind="partner"
                          role={(memberOf.get(p.id as string)?.role as string) ?? '—'}
                          invited={sgt(p.invited_at as string)}
                          first={p.first_seen_at ? sgt(p.first_seen_at as string) : 'never'}
                          last={p.last_seen_at ? sgt(p.last_seen_at as string) : 'never'}
                          status={p.status as string}
                          canAdmin={isAdmin}
                          isLastActiveAdmin={false}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-6 max-w-md rounded border p-4"
             style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <h3 className="text-sm font-semibold">Invite a partner user</h3>
          <p className="mb-3 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Creates a partner principal only. An address that already exists as any principal is
            refused.
          </p>
          <ActionForm action={invitePartnerUser} submitLabel="Send invitation">
            <Field label="E-mail" name="email" type="email" required mono />
            <Field label="Partner" name="partner_id" required options={
              (partners ?? []).map((p) => ({ value: p.id as string, label: p.display_name as string }))
            } />
            <Field label="Role" name="role" options={[
              { value: 'partner_user', label: 'Partner user — submit, correct, withdraw' },
              { value: 'partner_admin', label: 'Partner admin — also manages pairs' },
            ]} />
          </ActionForm>
        </div>
      </section>

      {/* ---- Staff access: deliberately separated (TM4) ---- */}
      <section className="mt-12 rounded border-2 p-4"
               style={{ borderColor: 'var(--expiring)', background: 'var(--surface)' }}>
        <h2 className="text-base font-semibold">Staff access</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          MetaComp staff. Only a backbone admin can create a staff principal or change a staff
          role — an operator cannot, by design.
        </p>

        <div className="table-scroll mt-4">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr style={{ borderBottom: `1px solid var(--border)` }}>
                <th scope="col" className="px-2 py-1 text-left">E-mail</th>
                <th scope="col" className="px-2 py-1 text-left">Role</th>
                <th scope="col" className="px-2 py-1 text-left">Invited</th>
                <th scope="col" className="px-2 py-1 text-left">First sign-in</th>
                <th scope="col" className="px-2 py-1 text-left">Last sign-in</th>
                <th scope="col" className="px-2 py-1 text-left">Status</th>
                <th scope="col" className="px-2 py-1"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {staffList.map((p) => {
                const role = (staffOf.get(p.id as string)?.role as string) ?? '—';
                return (
                  <PrincipalRow
                    key={p.id as string}
                    id={p.id as string}
                    email={String(p.email)}
                    kind="staff"
                    role={role}
                    invited={sgt(p.invited_at as string)}
                    first={p.first_seen_at ? sgt(p.first_seen_at as string) : 'never'}
                    last={p.last_seen_at ? sgt(p.last_seen_at as string) : 'never'}
                    status={p.status as string}
                    canAdmin={isAdmin}
                    isSelf={p.id === principal.id}
                    isLastActiveAdmin={
                      role === 'backbone_admin' && p.status === 'active' && activeAdmins <= 1
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>

        {isAdmin ? (
          <div className="mt-6 max-w-md rounded border p-4" style={{ borderColor: 'var(--border)' }}>
            <h3 className="text-sm font-semibold">Invite staff</h3>
            <p className="mb-3 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              This is the only path that creates a staff principal. A staff principal can never
              hold a partner membership.
            </p>
            <ActionForm action={inviteStaff} submitLabel="Send staff invitation" danger>
              <Field label="E-mail" name="email" type="email" required mono />
              <Field label="Role" name="role" options={[
                { value: 'rm_viewer', label: 'RM viewer — read the board, copy quotes' },
                { value: 'backbone_operator', label: 'Backbone operator — partner and partner-access admin' },
                { value: 'backbone_admin', label: 'Backbone admin — staff access, markup, registry' },
              ]} />
            </ActionForm>
          </div>
        ) : (
          <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>
            You are a backbone operator. Inviting staff requires a backbone admin.
          </p>
        )}
      </section>
    </AppShell>
  );
}
