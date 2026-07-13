import Link from 'next/link';
import BottomNav from '@/app/bottom-nav';
import { getAuthState } from '@capo/db/session';
import { getBillingState, type BillingState } from '@/lib/billing';

function BillingBanner({ billing }: { billing: BillingState }) {
  if (!billing.enabled) return null;
  if (billing.blocked) {
    return (
      <Link href="/subscricao" className="block bg-red-600 px-4 py-1.5 text-center text-xs font-medium text-white">
        A tua subscrição expirou — o WhatsApp continua a funcionar, mas o chat aqui e as ações ficam bloqueados. Toca
        para reativar.
      </Link>
    );
  }
  if (billing.status === 'trialing' && billing.daysLeft <= 7) {
    return (
      <Link href="/subscricao" className="block bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-white">
        {billing.daysLeft <= 0 ? 'O período de teste terminou' : `Faltam ${billing.daysLeft} dias de teste grátis`} —
        toca para assinar.
      </Link>
    );
  }
  return null;
}

// The logged-in shell: everything in (app) sits above the tab bar. Auth is
// enforced per page/route via requireAuth()/getApiAuth() — a layout persists
// across client-side navigations, so it cannot be the gate. The billing
// banner below is opportunistic (getAuthState, never redirects): with no
// session yet, the page underneath will redirect via its own requireAuth().
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const state = await getAuthState();
  const billing = state.status === 'ok' ? await getBillingState(state.ctx) : ({ enabled: false } as const);

  return (
    <>
      <BillingBanner billing={billing} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <BottomNav />
    </>
  );
}
