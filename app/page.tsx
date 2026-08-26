import { redirect } from 'next/navigation';
import { currentPrincipal, zoneFor } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** §5: land every principal in their one zone. */
export default async function Home() {
  const p = await currentPrincipal();
  redirect(p ? zoneFor(p) : '/login');
}
