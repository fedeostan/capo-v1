import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthState } from '@capo/db/session';
import { completeOnboarding } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Bem-vindo — Capo' };

// TODO(Federico): EU-PT microcopy dial — field labels and error notices.
const ERRORS: Record<string, string> = {
  dados: 'Preenche o nome da empresa e o teu nome.',
  telemovel: 'Número inválido. Usa o formato 912 345 678 ou +351 912 345 678.',
  'telemovel-usado': 'Esse número já está associado a outra conta.',
  guardar: 'Não foi possível guardar. Tenta de novo.',
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  // Session required; already-onboarded users skip straight to the app.
  const state = await getAuthState();
  if (state.status === 'unauthenticated') redirect('/login');
  if (state.status === 'ok') redirect('/');

  const { erro } = await searchParams;
  const errorText = erro ? ERRORS[erro] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">Bem-vindo ao Capo</h1>
        <p className="text-sm text-zinc-500">
          Só faltam dois dados para começares: a tua empresa e o teu telemóvel.
        </p>
      </div>

      <form action={completeOnboarding} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Nome da empresa</span>
          <input
            type="text"
            name="empresa"
            required
            maxLength={120}
            placeholder="Construções Silva, Lda."
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">O teu nome</span>
          <input
            type="text"
            name="nome"
            required
            maxLength={120}
            autoComplete="name"
            placeholder="João Silva"
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">O teu telemóvel</span>
          <input
            type="tel"
            name="telemovel"
            required
            autoComplete="tel"
            inputMode="tel"
            placeholder="912 345 678"
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
          <span className="block text-xs text-zinc-500">
            É para aqui que o Capo envia as mensagens do dia.
          </span>
        </label>
        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          Começar
        </button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}
    </div>
  );
}
