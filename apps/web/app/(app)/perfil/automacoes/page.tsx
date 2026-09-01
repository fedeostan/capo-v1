import type { Metadata } from 'next';
import Link from 'next/link';
import type { Catalog } from '@capo/i18n/catalog';
import { EmptyState, ScreenShell } from '@capo/ui/dashboard-ui';
import { Field, Select } from '@capo/ui/field';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { SEND_HOUR_CHOICES, scheduleWindow, type JobKind } from '@/lib/schedule';
import PullToRefresh from '@/app/pull-to-refresh';
import { Card, SubmitButton } from '../settings-controls';
import { saveSchedule } from './actions';
import { loadAutomations, type CronRunRow, type SendRow } from './data';

// Perfil → Mensagens automáticas (issue #51, part B).
//
// ── FEDERICO: this screen exists because of one morning. ────────────────────
// On 13 August the crew's 07:00 message went out at 07:49 and you had no way to
// know that. It was not lost, it was late — but from inside Capo a late message
// and a lost one looked exactly the same, and telling them apart took a log
// file at the hosting company that you cannot open.
//
// So the screen answers four questions, in this order:
//   1. what does Capo send, to whom, and when?     (and let me change the when)
//   2. what did it cost?                           (said out loud, at the top)
//   3. when was each run DUE, and when did it RUN? (the column that answers 13 Aug)
//   4. who heard nothing, and why?                 (the part that was invisible)

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.automations.title) };
}

/** Europe/Lisbon hours, always two digits. Never the reader's device clock —
 *  one clock, the same rule the whole product follows. */
function hhmm(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** The last minute of a window's final hour — 08:59, not 09:00. The difference
 *  matters: `withinSendWindow` compares whole Lisbon hours, so a send targeted
 *  at 07:00 really may go out at 08:58 and really may not at 09:00. */
function lastMinuteOf(hour: number): string {
  return `${String(hour).padStart(2, '0')}:59`;
}

/** The moment a run actually started, in Lisbon, formatted for the reader. */
function stamp(iso: string, t: Catalog): string {
  return new Intl.DateTimeFormat(t.meta.dateLocale, {
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function dayLabel(runDate: string, t: Catalog): string {
  return new Intl.DateTimeFormat(t.meta.dateLocale, {
    timeZone: 'Europe/Lisbon',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${runDate}T12:00:00Z`));
}

/**
 * How late this run actually was — the one number the whole issue is about.
 *
 * Measured from the DUE hour on the run's own date, in Lisbon, against when the
 * platform actually knocked. Negative or tiny values render as "on time": a run
 * that started a few seconds before the hour is not early in any sense a
 * manager cares about.
 */
function latenessMinutes(run: CronRunRow): number {
  const due = new Date(`${run.runDate}T00:00:00Z`);
  // The stored ran_at is absolute, so the comparison is done on absolute time:
  // the due instant is the run's Lisbon hour, and lisbon_hour() on the same
  // invocation is what produced ran_hour. Rather than reconstruct the offset,
  // take it from the difference the two already encode.
  const ranAt = new Date(run.ranAt);
  const offsetHours = run.ranHour - ranAt.getUTCHours();
  // A run that crosses midnight UTC would read as ±23; the window never wraps
  // past midnight Lisbon, so normalise into (-12, 12] and trust the small one.
  const offset = ((((offsetHours + 12) % 24) + 24) % 24) - 12;
  due.setUTCHours(run.dueHour - offset);
  return Math.round((ranAt.getTime() - due.getTime()) / 60000);
}

// Deliberately not localised beyond the number: "min" and "h" read the same in
// all three languages this product speaks, and inventing three spellings of an
// abbreviation is copy nobody asked for — which is also why this takes no
// catalog.
function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function ScheduleForm({
  jobKind,
  sendHour,
  enabled,
  chosen,
  t,
}: {
  jobKind: JobKind;
  sendHour: number;
  enabled: boolean;
  chosen: boolean;
  t: Catalog;
}) {
  const job = t.automations.job[jobKind];
  const window = scheduleWindow(sendHour);

  return (
    <form action={saveSchedule} className="space-y-3">
      <input type="hidden" name="mensagem" value={jobKind} />

      <div>
        <p className="text-callout font-semibold">{job.name}</p>
        <p className="mt-1 text-caption text-fg-muted">{job.what}</p>
        <p className="mt-1 text-caption text-fg-muted">{job.who}</p>
      </div>

      <div className="rounded-lg bg-surface-sunken px-3 py-2">
        <p className="text-caption">{t.automations.aimedAt(hhmm(sendHour))}</p>
        {/* The WINDOW, said out loud. "07:00" is what was promised on 13 August
            and 07:49 is what arrived; stating the range is how the product
            stops claiming a precision the platform does not have. */}
        <p className="mt-1 text-caption text-fg-muted">
          {t.automations.window(hhmm(window.from), lastMinuteOf(window.to))}
        </p>
        {!chosen && <p className="mt-1 text-caption text-fg-muted">{t.automations.usingDefault}</p>}
      </div>

      <Field id={`hora-${jobKind}`} label={t.automations.hourLabel}>
        {a11y => (
          <Select {...a11y} name="hora" defaultValue={String(sendHour)}>
            {SEND_HOUR_CHOICES.map(hour => (
              <option key={hour} value={hour}>
                {hhmm(hour)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* A checkbox rather than the radio pair /perfil uses for consent: this
          one only ever reduces spend, so a mis-tap costs a message rather than
          withdrawing a permission. It still needs an explicit Save. */}
      <label className="flex items-start gap-2 text-callout">
        <input
          type="checkbox"
          name="activa"
          value="1"
          defaultChecked={enabled}
          className="mt-1 size-4 shrink-0 accent-brand"
        />
        <span>{t.automations.enabledLabel}</span>
      </label>

      <SubmitButton label={t.common.save} />
    </form>
  );
}

function Recipient({ send, t }: { send: SendRow; t: Catalog }) {
  const tone =
    send.outcome === 'failed'
      ? 'text-danger'
      : send.outcome === 'read' || send.outcome === 'delivered'
        ? 'text-success'
        : 'text-fg-muted';
  const codeKey = send.errorCode === null ? null : (String(send.errorCode) as keyof Catalog['automations']['metaError']);
  const explained = codeKey && codeKey in t.automations.metaError ? t.automations.metaError[codeKey] : null;

  return (
    <li className="border-t border-hairline py-2 first:border-t-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-callout">
          {send.name ?? '—'}
          <span className="ml-1 text-caption text-fg-muted">
            {send.audience === 'manager' ? t.automations.recipientManager : t.automations.recipientWorker}
          </span>
        </p>
        <p className={`shrink-0 text-caption font-medium ${tone}`}>{t.automations.outcome[send.outcome]}</p>
      </div>
      <p className="mt-1 text-caption text-fg-muted">{t.automations.outcomeHint[send.outcome]}</p>
      {send.outcome === 'failed' && (
        <div className="mt-1 rounded-lg bg-danger-quiet px-2 py-1">
          {/* Plain language FIRST, then Meta's own words. The code is kept
              because it is what a support conversation with Meta needs, and
              the raw text because our explanation may be for the wrong code. */}
          <p className="text-caption text-danger">
            {explained ?? t.automations.metaErrorUnknown}
          </p>
          <p className="mt-1 break-words text-caption text-fg-muted">
            {send.errorCode !== null && <>{t.automations.metaErrorLabel(send.errorCode)} · </>}
            {send.errorText}
          </p>
        </div>
      )}
    </li>
  );
}

function Run({ run, sends, t }: { run: CronRunRow; sends: SendRow[]; t: Catalog }) {
  const late = latenessMinutes(run);
  const job = t.automations.job[run.jobKind as JobKind];
  const excluded =
    run.excludedNoConsent + run.excludedUnreachable + run.excludedInactive + run.managersNoConsent;

  return (
    <details className="rounded-xl border border-hairline p-3">
      <summary className="cursor-pointer list-none">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-callout font-medium">{job?.name ?? run.jobKind}</p>
          <p className="shrink-0 text-caption text-fg-muted">{dayLabel(run.runDate, t)}</p>
        </div>
        {/* THE TWO TIMES, SIDE BY SIDE. This single line is what would have
            answered 13 August without a hosting-company log. */}
        <p className="mt-1 text-caption">
          <span className="text-fg-muted">{t.automations.due}</span> {hhmm(run.dueHour)}
          {' · '}
          <span className="text-fg-muted">{t.automations.ran}</span> {stamp(run.ranAt, t)}
          {' · '}
          <span className={late >= 30 ? 'font-medium text-warn' : 'text-fg-muted'}>
            {late >= 1 ? t.automations.lateBy(minutesLabel(late)) : t.automations.onTime}
          </span>
        </p>
        <p className="mt-1 text-caption text-fg-muted">
          {run.messaged === 0 && run.failed === 0 && run.skippedIdle === 0
            ? t.automations.nothingSent
            : [
                t.automations.messagedCount(run.messaged),
                run.failed > 0 ? t.automations.failedCount(run.failed) : null,
                run.skippedIdle > 0 ? t.automations.skippedCount(run.skippedIdle) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </p>
      </summary>

      <div className="mt-3 space-y-2">
        {excluded > 0 && (
          <ul className="space-y-1 rounded-lg bg-warn-quiet px-2 py-2">
            {run.excludedNoConsent > 0 && (
              <li className="text-caption text-warn">
                {run.excludedNoConsent} · {t.automations.reason.noConsent}
              </li>
            )}
            {run.excludedUnreachable > 0 && (
              <li className="text-caption text-warn">
                {run.excludedUnreachable} · {t.automations.reason.unreachable}
              </li>
            )}
            {run.excludedInactive > 0 && (
              <li className="text-caption text-warn">
                {run.excludedInactive} · {t.automations.reason.inactive}
              </li>
            )}
            {run.managersNoConsent > 0 && (
              <li className="text-caption text-warn">
                {run.managersNoConsent} · {t.automations.reason.managerNoConsent}
              </li>
            )}
          </ul>
        )}
        {run.noManagerAccount && (
          <p className="rounded-lg bg-warn-quiet px-2 py-2 text-caption text-warn">
            {t.automations.reason.noManagerAccount}
          </p>
        )}
        {sends.length > 0 && <ul>{sends.map(send => <Recipient key={send.id} send={send} t={t} />)}</ul>}
      </div>
    </details>
  );
}

export default async function AutomacoesPage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { guardado, erro } = await searchParams;
  const data = await loadAutomations(ctx);

  // Grouped in TypeScript rather than in the query: the two reads are already
  // scoped to the same company and the same fortnight, and a join in SQL would
  // have meant company_send_history returning cron_runs columns it has no
  // business exposing.
  const sendsByRun = new Map<string, SendRow[]>();
  for (const send of data.sends) {
    const key = `${send.jobKind}:${send.runDate}`;
    sendsByRun.set(key, [...(sendsByRun.get(key) ?? []), send]);
  }

  return (
    <ScreenShell title={t.automations.title} subtitle={t.automations.subtitle}>
      <PullToRefresh locale={locale}>
        {guardado && (
          <p className="rounded-lg bg-success-quiet px-3 py-2 text-center text-callout text-success">
            {t.automations.saved}
          </p>
        )}
        {erro && (
          <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
            {erro === 'hora' ? t.automations.invalidHour : t.automations.saveFailed}
          </p>
        )}

        {/* THE COST, at the top, before any control that adds any. A schedule
            screen is a spending screen — every recipient of every send is a
            paid WhatsApp template. */}
        <p className="rounded-lg bg-warn-quiet px-3 py-2 text-caption text-warn">
          {t.automations.costNote}
        </p>

        {data.jobs.map(({ jobKind, schedule }) => (
          <Card key={jobKind} title={schedule.enabled ? t.automations.on : t.automations.off}>
            <ScheduleForm
              jobKind={jobKind}
              sendHour={schedule.sendHour}
              enabled={schedule.enabled}
              chosen={schedule.chosen}
              t={t}
            />
          </Card>
        ))}

        {/* Said, not hidden behind a disabled button. A manager who wants a
            third message deserves to know it is Meta's approval process in the
            way and not a missing screen. */}
        <Card title={t.automations.addTitle}>
          <p className="text-caption text-fg-muted">{t.automations.addExplanation}</p>
        </Card>

        <Card title={t.automations.reasonTitle}>
          <p className="text-caption text-fg-muted">{t.automations.reasonNamesHint}</p>
          {data.skips.length === 0 && data.managerNoConsent.length === 0 && !data.noManagerAccount ? (
            <p className="text-caption text-fg-muted">{t.automations.reasonNobody}</p>
          ) : (
            <ul className="space-y-2">
              {data.skips.map(skip => (
                <li key={`${skip.name}-${skip.reason}`} className="text-callout">
                  {skip.name}
                  <span className="ml-1 text-caption text-fg-muted">{t.automations.reason[skip.reason]}</span>
                </li>
              ))}
              {data.managerNoConsent.map(name => (
                <li key={`m-${name}`} className="text-callout">
                  {name}
                  <span className="ml-1 text-caption text-fg-muted">{t.automations.reason.managerNoConsent}</span>
                </li>
              ))}
              {data.noManagerAccount && (
                <li className="text-callout text-warn">
                  {t.automations.reason.noManagerAccount}
                </li>
              )}
            </ul>
          )}
          <Link href="/perfil" className="inline-block text-callout text-brand underline">
            {t.profile.title}
          </Link>
        </Card>

        <Card title={t.automations.historyTitle}>
          <p className="text-caption text-fg-muted">{t.automations.historyHint}</p>
          <p className="text-caption text-fg-muted">{t.automations.debugHint}</p>
          {data.runs.length === 0 ? (
            <EmptyState text={t.automations.historyEmpty} />
          ) : (
            <div className="space-y-2">
              {data.runs.map(run => (
                <Run
                  key={`${run.jobKind}-${run.runDate}`}
                  run={run}
                  sends={sendsByRun.get(`${run.jobKind}:${run.runDate}`) ?? []}
                  t={t}
                />
              ))}
            </div>
          )}
          {/* The one degradation worth naming on screen: the per-recipient read
              is a database function, and a deploy that lands before its
              migration has none. The runs above still render. */}
          {data.historyUnavailable && (
            <p className="text-caption text-fg-muted">{t.automations.debugTitle} — {t.automations.historyEmpty}</p>
          )}
        </Card>
      </PullToRefresh>
    </ScreenShell>
  );
}
