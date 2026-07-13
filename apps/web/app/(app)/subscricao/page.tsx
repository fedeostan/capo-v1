import type { Metadata } from 'next';
import { requireAuth } from '@capo/db/session';
import { getBillingState } from '@/lib/billing';
import { startCheckout, openPortal } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Subscrição — Capo' };

const STATUS_LABEL: Record<string, string> = {
  active: 'Subscrição ativa',
  past_due: 'Pagamento em falta',
  canceled: 'Subscrição cancelada',
};

export default async function SubscricaoPage({
  searchParams,
}: {
  searchParams: Promise<{ sucesso?: string }>;
}) {
  const ctx = await requireAuth();
  const state = await getBillingState(ctx);
  const { sucesso } = await searchParams;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">💳</p>
        <h1 className="text-2xl font-semibold">Subscrição</h1>
      </div>

      {sucesso && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
          Subscrição ativada. Obrigado!
        </p>
      )}

      {!state.enabled ? (
        <p className="rounded-lg bg-zinc-500/10 px-3 py-2 text-center text-sm text-zinc-500">
          A faturação ainda não está disponível.
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-zinc-500/20 p-4 text-center">
            <p className="text-sm font-medium">
              {state.status === 'trialing'
                ? state.daysLeft >= 0
                  ? `${state.daysLeft} dias de teste grátis restantes`
                  : 'Período de teste terminado'
                : (STATUS_LABEL[state.status] ?? state.status)}
            </p>
            <p className="mt-1 text-xs text-zinc-500">€45/mês · sem cartão para começar · sem custo por trabalhador</p>
          </div>

          {state.status === 'active' ? (
            <form action={openPortal}>
              <button
                type="submit"
                className="w-full rounded-lg border border-zinc-500/30 py-2.5 text-sm font-semibold hover:bg-zinc-500/10"
              >
                Gerir subscrição
              </button>
            </form>
          ) : (
            <form action={startCheckout}>
              <button
                type="submit"
                className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
              >
                Assinar — €45/mês
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
