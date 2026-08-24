import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@capo/ui/dashboard-ui';
import { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
import { loadTeam, loadTeamLoad } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { RoomShell } from '../room-shell';
import { Card } from '../settings-controls';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.shell.rooms.team.title) };
}

// No Flash here, and that is correct rather than an omission: this room hosts
// no form. Crew changes go through Capo's add_worker tool — the chat writes,
// this reads.
export default async function EquipaPage() {
  const { ctx, locale, t } = await requireAuthT();
  const [team, teamLoad] = await Promise.all([loadTeam(ctx), loadTeamLoad(ctx)]);

  return (
    <RoomShell title={t.shell.rooms.team.title} backLabel={t.profile.title} locale={locale}>
      <Card title={t.profile.team}>
        {/* Read-only on purpose: worker CRUD stays on Capo's add_worker tool.
            The chat writes. */}
        {team.length === 0 ? (
          <EmptyState text={t.profile.teamEmpty} cta={{ href: '/', label: t.profile.teamEmptyCta }} />
        ) : (
          <>
            <ul className="space-y-3">
              {team.map(worker => {
                const load = teamLoad[worker.id];
                return (
                  <li key={worker.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{worker.name}</p>
                      <p className="text-xs text-zinc-500">
                        {[worker.trade, worker.phone].filter(Boolean).join(' · ') || t.profile.noContact}
                      </p>
                      {/* Load turns the crew list from a phone book into an
                          answer to "who is free?" — the question actually
                          asked before assigning work. */}
                      {load && load.open > 0 && (
                        <p className="text-xs text-zinc-500">
                          {t.profile.workerLoad(load.today, load.tomorrow, load.open)}
                        </p>
                      )}
                      {/* THREE states, not two, and the middle one is new.
                          An active worker with no number was always the silent
                          failure worth shouting about — the daily WhatsApp
                          messages are addressed to workers.phone, so without
                          one they reach nobody. Since 0025 there is a second
                          way to be unreachable while looking fine: a number on
                          file but no recorded consent. Reporting that as
                          "receives WhatsApp" would be the product lying about
                          the very thing the manager needs to act on. */}
                      {worker.active &&
                        (!worker.phone ? (
                          <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                            {t.profile.noWhatsAppWarning}
                          </p>
                        ) : !hasWhatsAppConsent(worker) ? (
                          <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                            {t.profile.noConsentWarning}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11px] text-zinc-500">{t.profile.receivesWhatsApp}</p>
                        ))}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {!worker.active && (
                        <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] text-zinc-500">
                          {t.profile.inactive}
                        </span>
                      )}
                      {load && load.overdue > 0 && (
                        <span className="text-[11px] font-medium text-red-600">
                          {t.dashboard.overdueCount(load.overdue)}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-zinc-500">
              {t.profile.teamHint}{' '}
              <Link href="/" className="underline">
                {t.profile.teamHintLink}
              </Link>
              .
            </p>
            {/* The cost of recording consent, said where the whole crew is
                visible at once (issue #45). Each person Capo is newly allowed
                to message gets one welcome, and each welcome is a paid
                template — so this multiplies by the size of the crew, which
                is a fact only this screen can show. */}
            <p className="text-xs text-zinc-500">{t.profile.welcomeCostHint}</p>
          </>
        )}
      </Card>
    </RoomShell>
  );
}
