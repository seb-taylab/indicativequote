import { requirePartner } from '@/lib/auth';
import { AppShell } from '@/components/AppShell';

export const dynamic = 'force-dynamic';

export default async function PartnerHome() {
  const principal = await requirePartner(['partner_user', 'partner_admin']);
  return <AppShell principal={principal} title="Your rates">{null}</AppShell>;
}
