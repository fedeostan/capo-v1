import Link from 'next/link';
import type { AgendaCounts } from '@capo/ui/dashboard-ui';

// The Hoje/Amanhã/Atrasadas switcher, sitting at the top of all three screens.
//
// These used to be three separate bottom-nav tabs. Folding them into one
// switcher freed the two slots Equipa and Materiais needed, and — more
// importantly — puts the overdue count permanently on screen. That number is
// the one a manager most needs and is least likely to go looking for.
//
// Lives in the app rather than @capo/ui so it can use next/link: a manager
// flicks between these three several times a day, and a full document reload
// each time is very noticeable on a phone.
export default function AgendaTabs({
  current,
  counts,
}: {
  current: 'hoje' | 'amanha' | 'atrasadas';
  counts: AgendaCounts;
}) {
  const tabs = [
    { key: 'hoje', href: '/hoje', label: 'Hoje', count: counts.hoje, alert: false },
    { key: 'amanha', href: '/amanha', label: 'Amanhã', count: counts.amanha, alert: false },
    { key: 'atrasadas', href: '/atrasadas', label: 'Atrasadas', count: counts.atrasadas, alert: true },
  ] as const;

  return (
    <nav className="flex gap-1 rounded-xl bg-zinc-500/10 p-1">
      {tabs.map(tab => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium ${
              active ? 'bg-background shadow-sm' : 'text-zinc-500 hover:text-zinc-400'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                  tab.alert ? 'bg-red-600 text-white' : 'bg-zinc-500/20 text-zinc-500'
                }`}
              >
                {tab.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
