import type { Principal } from '@/lib/auth';
import { signOut } from '@/app/login/actions';

/**
 * §5: "A principal only ever sees one zone." The navigation shown here is
 * built from the principal's own role, so a partner is never offered a link
 * into the internal zone and an rm_viewer is never offered an admin link.
 *
 * This is convenience, not security. Every one of these destinations re-checks
 * the caller server-side, and the database refuses regardless — "Route guards
 * are convenience; the database is the boundary."
 */
function navFor(p: Principal): Array<{ href: string; label: string }> {
  if (p.kind === 'partner') {
    const nav = [
      { href: '/partner', label: 'Home' },
      { href: '/partner/submit', label: 'Submit rates' },
      { href: '/partner/history', label: 'History' },
    ];
    // D15: partner_admin manages pairs, and invites nobody.
    if (p.partnerRole === 'partner_admin') {
      nav.splice(2, 0, { href: '/partner/pairs', label: 'Pairs' });
    }
    return nav;
  }

  const nav = [{ href: '/board', label: 'Board' }];
  if (p.staffRole === 'backbone_operator' || p.staffRole === 'backbone_admin') {
    nav.push(
      { href: '/admin/partners', label: 'Partners' },
      { href: '/admin/access', label: 'Access' },
      { href: '/admin/health', label: 'Health' },
      { href: '/admin/audit', label: 'Audit' },
    );
  }
  if (p.staffRole === 'backbone_admin') {
    nav.push({ href: '/admin/markup', label: 'Markup' });
  }
  return nav;
}

export function AppShell({
  principal,
  title,
  children,
}: {
  principal: Principal;
  title: string;
  children: React.ReactNode;
}) {
  const nav = navFor(principal);

  return (
    <div className="min-h-screen">
      <header style={{ borderBottom: `1px solid var(--border)`, background: 'var(--surface)' }}>
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold tracking-tight">MetaComp Rate Hub</span>
          <nav aria-label="Sections" className="flex flex-wrap gap-4 text-sm">
            {nav.map((n) => (
              <a key={n.href} href={n.href} style={{ color: 'var(--accent)' }}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
            <span className="num">
              {principal.partnerName ? `${principal.partnerName} · ` : ''}
              {principal.email}
            </span>
            <form action={signOut}>
              <button type="submit" className="underline">Sign out</button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1600px] px-4 py-6">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {children}
      </main>
    </div>
  );
}
