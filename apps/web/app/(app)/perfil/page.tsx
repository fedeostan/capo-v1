import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuth } from '@capo/db/session';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { loadTeam } from '@/app/dashboard-data';
import { getBillingState } from '@/lib/billing';
import { AccountForm, CompanyForm } from './profile-forms';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Perfil — Capo' };

const BILLING_LABEL: Record<string, string> = {
  active: 'Subscrição ativa',
  past_due: 'Pagamento em falta',
  canceled: 'Subscrição cancelada',
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-zinc-500/20 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

// Everything about the company and the account lives here: it is the only tab
// that owns settings, so nothing else in the app needs a header action.
export default async function PerfilPage() {
  const ctx = await requireAuth();
  const { db, userId, companyId } = ctx;

  const [{ data: company }, { data: profile }, { data: claims }, team, billing] = await Promise.all([
    db.from('companies').select('name').eq('id', companyId).maybeSingle(),
    db.from('profiles').select('full_name, phone').eq('id', userId).maybeSingle(),
    db.auth.getClaims(),
    loadTeam(ctx),
    getBillingState(ctx),
  ]);

  const email = typeof claims?.claims?.email === 'string' ? claims.claims.email : null;

  return (
    <ScreenShell title="Perfil" subtitle={company?.name ?? undefined}>
      <Card title="Empresa">
        <CompanyForm name={company?.name ?? ''} />
      </Card>

      <Card title="A tua conta">
        {/* Changing the login email is a Supabase auth flow with its own
            confirmation round trip — out of scope here, so it is read-only. */}
        {email && <p className="text-xs text-zinc-500">{email}</p>}
        <AccountForm fullName={profile?.full_name ?? ''} phone={profile?.phone ?? ''} />
      </Card>

      <Card title="Equipa">
        {/* Read-only on purpose: worker CRUD stays on Capo's add_worker tool.
            The chat writes. */}
        {team.length === 0 ? (
          <EmptyState
            text="Ainda não há ninguém na equipa."
            cta={{ href: '/', label: 'Pede ao Capo para adicionar' }}
          />
        ) : (
          <>
            <ul className="space-y-2">
              {team.map(worker => (
                <li key={worker.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{worker.name}</p>
                    <p className="text-xs text-zinc-500">
                      {[worker.trade, worker.phone].filter(Boolean).join(' · ') || 'Sem contacto'}
                    </p>
                  </div>
                  {!worker.active && (
                    <span className="shrink-0 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-500">
                      inativo
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-zinc-500">
              Para adicionar ou alterar alguém,{' '}
              <Link href="/" className="underline">
                fala com o Capo
              </Link>
              .
            </p>
          </>
        )}
      </Card>

      <Card title="Subscrição">
        <p className="text-sm">
          {!billing.enabled
            ? 'A faturação ainda não está disponível.'
            : billing.status === 'trialing'
              ? billing.daysLeft >= 0
                ? `${billing.daysLeft} dias de teste grátis restantes`
                : 'Período de teste terminado'
              : (BILLING_LABEL[billing.status] ?? billing.status)}
        </p>
        <Link href="/subscricao" className="inline-block text-sm text-orange-600 underline">
          Gerir subscrição
        </Link>
      </Card>

      <Card title="App">
        <Link href="/instalar" className="inline-block text-sm text-orange-600 underline">
          Instalar no telemóvel
        </Link>
      </Card>

      {/* Plain form POST: sign-out works even before client JS hydrates. */}
      <form method="post" action="/auth/signout">
        <button
          type="submit"
          className="w-full rounded-xl border border-zinc-500/20 py-2.5 text-sm font-medium text-red-600 hover:bg-red-600/5"
        >
          Sair
        </button>
      </form>
    </ScreenShell>
  );
}
