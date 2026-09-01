import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@capo/ui/dashboard-ui';
import { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
import { loadTeam, loadTeamLoad } from '@/app/dashboard-data';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { RoomShell } from '../room-shell';
import { Card } from '../settings-controls';

export const dynamic = 'force-dynamic';

// How long a crew member may sit consented-but-silent before the "waiting for
// their first reply" line changes tone (issue #153).
//
// THREE DAYS, and the shape matters more than the number: this is an
// escalation of the SAME line, not a second badge. A permanent warning is
// wallpaper within a week, so the calm version is what a manager sees for the
// first couple of days — which is also the window in which a reply is most
// likely to arrive on its own, because the person has just been added and is
// getting a message every morning. By day three the silence has survived
// several briefings and is no longer plausibly "they haven't looked yet".
//
// Measured from `whatsapp_opt_in_at`, not from when the worker row was
// created: consent is what starts Capo messaging them, and a crew member added
// in March and consented in August has been reachable for days, not months.
const FIRST_REPLY_CHASE_DAYS = 3;

/** Whole days elapsed since an ISO timestamp, or null if it cannot be read.
 *
 *  Null on an unparseable value is deliberate and matches hasWhatsAppConsent's
 *  direction: the quieter line is the safe one to fall back to. Nothing here
 *  decides whether a message may be SENT — consent has already been settled by
 *  the time this is called — so this is a tone dial, never a gate. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/** A wa.me link that opens WhatsApp with `text` already typed, addressed to
 *  this number. Capo sends NOTHING: the manager presses send, from their own
 *  phone, so the message arrives as a person the crew member already knows
 *  rather than as another automated number.
 *
 *  wa.me wants bare digits — no `+`, no spaces. `workers.phone` is validated
 *  E.164 on the way in, so stripping non-digits is a normalisation, not a
 *  repair. */
function whatsappComposeLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

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
          <EmptyState text={t.profile.teamEmpty} cta={{ href: '/chat', label: t.profile.teamEmptyCta }} />
        ) : (
          <>
            <ul className="space-y-3">
              {team.map(worker => {
                const load = teamLoad[worker.id];
                // The fourth state's two dials, computed once per row. Only
                // ever consulted below the consent branch, so `waitingDays`
                // being read off an opt-in that hasWhatsAppConsent has already
                // accepted is safe.
                const awaitingFirstReply = Boolean(worker.phone) && !worker.last_inbound_at;
                const waitingDays = daysSince(worker.whatsapp_opt_in_at);
                // Null unless the threshold is past, so the escalated wording
                // and the number it quotes can never disagree.
                const chaseDays =
                  waitingDays !== null && waitingDays >= FIRST_REPLY_CHASE_DAYS ? waitingDays : null;
                return (
                  <li key={worker.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-callout font-medium">{worker.name}</p>
                      <p className="text-caption text-fg-muted">
                        {[worker.trade, worker.phone].filter(Boolean).join(' · ') || t.profile.noContact}
                      </p>
                      {/* Load turns the crew list from a phone book into an
                          answer to "who is free?" — the question actually
                          asked before assigning work. */}
                      {load && load.open > 0 && (
                        <p className="text-caption text-fg-muted">
                          {t.profile.workerLoad(load.today, load.tomorrow, load.open)}
                        </p>
                      )}
                      {/* FOUR states now, and the ladder is only ever
                          extended, never reordered.
                          An active worker with no number was always the silent
                          failure worth shouting about — the daily WhatsApp
                          messages are addressed to workers.phone, so without
                          one they reach nobody. Since 0025 there is a second
                          way to be unreachable while looking fine: a number on
                          file but no recorded consent. Reporting that as
                          "receives WhatsApp" would be the product lying about
                          the very thing the manager needs to act on.

                          The third rung is issue #153, and it is the subtlest:
                          consent is recorded, the paid 07:00 template is
                          arriving, and this person has still never written to
                          Capo. Everything free-form is therefore closed to
                          them — Capo cannot answer them at all, cannot send
                          the /dia link, and falls back to plain text instead
                          of the tappable list. "Receives WhatsApp" was true
                          and hid all of that. */}
                      {worker.active &&
                        (!worker.phone ? (
                          <p className="mt-1 text-micro font-medium text-warn">
                            {t.profile.noWhatsAppWarning}
                          </p>
                        ) : !hasWhatsAppConsent(worker) ? (
                          <p className="mt-1 text-micro font-medium text-warn">
                            {t.profile.noConsentWarning}
                          </p>
                        ) : awaitingFirstReply ? (
                          <>
                            <p
                              className={
                                chaseDays === null
                                  ? 'mt-1 text-micro text-fg-muted'
                                  : 'mt-1 text-micro font-medium text-warn'
                              }
                            >
                              {chaseDays === null
                                ? t.profile.awaitingFirstReply
                                : t.profile.awaitingFirstReplyChase({ days: chaseDays })}
                            </p>
                            {/* The smallest control that helps: WhatsApp opens
                                on the manager's own phone with the words
                                already typed, addressed to this crew member.
                                Capo sends nothing — a nudge from a number the
                                worker recognises is the only thing that ever
                                gets answered. */}
                            <a
                              href={whatsappComposeLink(
                                worker.phone,
                                t.profile.firstReplyMessage({ name: worker.name }),
                              )}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-block text-micro font-medium text-brand underline"
                            >
                              {t.profile.firstReplyAction}
                            </a>
                          </>
                        ) : (
                          <p className="mt-1 text-micro text-fg-muted">{t.profile.receivesWhatsApp}</p>
                        ))}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {!worker.active && (
                        <span className="rounded-full bg-surface-sunken px-2 py-1 text-micro text-fg-muted">
                          {t.profile.inactive}
                        </span>
                      )}
                      {load && load.overdue > 0 && (
                        <span className="text-micro font-medium text-danger">
                          {t.dashboard.overdueCount(load.overdue)}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-caption text-fg-muted">
              {t.profile.teamHint}{' '}
              <Link href="/chat" className="underline">
                {t.profile.teamHintLink}
              </Link>
              .
            </p>
            {/* The cost of recording consent, said where the whole crew is
                visible at once (issue #45). Each person Capo is newly allowed
                to message gets one welcome, and each welcome is a paid
                template — so this multiplies by the size of the crew, which
                is a fact only this screen can show. */}
            <p className="text-caption text-fg-muted">{t.profile.welcomeCostHint}</p>
          </>
        )}
      </Card>
    </RoomShell>
  );
}
