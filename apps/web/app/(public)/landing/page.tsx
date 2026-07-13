import type { Metadata } from 'next';
import Link from 'next/link';

// Anti-app positioning: an assistant that runs the manager's WhatsApp and
// automates the paperwork — never "construction management software". Server
// component only, no client JS, no animation libraries — one tasteful page.
export const metadata: Metadata = {
  title: 'Capo — O assistente que gere o teu WhatsApp',
  description:
    'O assistente de IA que gere o teu WhatsApp e trata da papelada da obra. Envia o orçamento, o Capo faz o plano dia a dia, a equipa recebe o briefing de manhã.',
  openGraph: {
    title: 'Capo — O assistente que gere o teu WhatsApp',
    description: 'Envia o orçamento, o Capo faz o plano dia a dia e avisa a equipa todas as manhãs. €45/mês, 14 dias grátis.',
    type: 'website',
  },
};

const STEPS = [
  { title: 'Envia o orçamento', text: 'Cola o orçamento ou descreve a obra numa mensagem — como falarias com um capataz.' },
  { title: 'O Capo faz o plano dia a dia', text: 'Sequência de tarefas, datas e materiais, prontos para aprovares num cartão.' },
  { title: 'A equipa recebe o briefing de manhã', text: 'Cada trabalhador recebe por SMS as tarefas do dia — sem apps, sem contas.' },
];

export default function LandingPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-16 px-6 py-16">
      <header className="space-y-4 text-center">
        <p className="text-5xl">👷</p>
        <h1 className="text-3xl font-bold sm:text-4xl">
          O assistente que gere o teu WhatsApp e trata da papelada da obra
        </h1>
        <p className="mx-auto max-w-xl text-zinc-500">
          Não é software de gestão de obras. É o capataz virtual que fala contigo por WhatsApp, organiza a equipa e
          nunca esquece o que falta.
        </p>
        <div className="flex flex-col items-center gap-3 pt-2 sm:flex-row sm:justify-center">
          <Link
            href="/registar"
            className="w-full rounded-lg bg-orange-600 px-6 py-3 text-center font-semibold text-white active:bg-orange-700 sm:w-auto"
          >
            Começar grátis — 14 dias
          </Link>
          <Link href="/login" className="text-sm text-zinc-500 underline">
            Já tenho conta — Entrar
          </Link>
        </div>
      </header>

      <section className="grid gap-6 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <div key={step.title} className="rounded-xl border border-zinc-500/20 p-4">
            <p className="text-xs font-semibold text-orange-600">Passo {i + 1}</p>
            <h2 className="mt-1 font-semibold">{step.title}</h2>
            <p className="mt-1 text-sm text-zinc-500">{step.text}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-orange-600/30 bg-orange-600/5 p-6 text-center">
        <h2 className="font-semibold">Antecipação de materiais</h2>
        <p className="mt-1 text-sm text-zinc-500">
          O Capo avisa a equipa com antecedência de que materiais vão precisar amanhã — nada de descobrir no dia que
          falta o quê.
        </p>
      </section>

      <section className="rounded-xl border border-zinc-500/20 p-6 text-center">
        <p className="text-3xl font-bold">
          €45<span className="text-base font-normal text-zinc-500">/mês</span>
        </p>
        <p className="mt-1 text-sm text-zinc-500">14 dias grátis · sem cartão · sem custo por trabalhador</p>
        <Link
          href="/registar"
          className="mt-4 inline-block w-full rounded-lg bg-orange-600 px-6 py-3 font-semibold text-white active:bg-orange-700 sm:w-auto"
        >
          Começar grátis
        </Link>
      </section>

      <footer className="text-center text-xs text-zinc-500">
        <Link href="/login" className="underline">
          Entrar
        </Link>
      </footer>
    </div>
  );
}
