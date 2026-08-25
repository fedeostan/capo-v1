import type { Metadata } from 'next';
import { Card } from '@capo/ui/card';
import { AppBar, ListRow } from '@/app/_ui/nav';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { getBillingState } from '@/lib/billing';
import PullToRefresh from '@/app/pull-to-refresh';
import SignOutButton from './sign-out-button';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.profile.title) };
}

// The same five rooms the profile drawer lists, as a plain page.
//
// TWO DOORS TO ONE PLACE, ON PURPOSE. The drawer is the phone-native shortcut;
// this is what a bookmark, a desktop-width browser and a deep link land on.
// Both lead to the identical routes, so the two cannot drift — the alternative
// (rooms reachable only from a client-rendered drawer) would mean a refresh
// throws you out of the screen you are reading, and it would put the settings
// forms behind a client boundary they must not be behind.
//
// Billing is /subscricao, which already existed with its own Stripe actions.
// Its status line used to be a card at the bottom of this page, where a trial
// running out was something you found by scrolling. As a row subtitle it is
// visible without opening anything.
export default async function PerfilPage() {
  const { ctx, locale, t } = await requireAuthT();
  const billing = await getBillingState(ctx);

  const billingMeta = !billing.enabled
    ? t.billing.unavailable
    : billing.status === 'trialing'
      ? billing.daysLeft >= 0
        ? t.billing.trialDaysLeft(billing.daysLeft)
        : t.billing.trialEnded
      : (t.billing.statusLabel[billing.status as keyof typeof t.billing.statusLabel] ?? billing.status);

  const rooms = [
    { href: '/perfil/pessoal', ...t.shell.rooms.personal },
    { href: '/perfil/equipa', ...t.shell.rooms.team },
    { href: '/subscricao', title: t.shell.rooms.billing.title, sub: billingMeta },
    { href: '/perfil/privacidade', ...t.shell.rooms.privacy },
    { href: '/perfil/definicoes', ...t.shell.rooms.settings },
  ];

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <AppBar title={t.profile.title} />
      <PullToRefresh locale={locale}>
        <Card padding="none">
          {rooms.map(room => (
            <ListRow key={room.href} href={room.href} title={room.title} meta={room.sub} />
          ))}
        </Card>
        <SignOutButton locale={locale} />
      </PullToRefresh>
    </div>
  );
}
