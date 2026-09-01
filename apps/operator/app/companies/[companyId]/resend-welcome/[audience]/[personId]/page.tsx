import Link from 'next/link';
import { loadWelcomeResendContext, type ResendAudience } from '../../../../../data';
import { describeRecipient } from '../../../../../welcome-resend';
import { resendWelcome } from './actions';

// The preview-and-confirm screen for resending one person's welcome (issue
// #123, part A). Nothing on this page sends anything: it shows exactly what
// WOULD be sent, to whom, and why the button is or is not available, and the
// send happens only when the operator submits the form — which re-reads all of
// it fresh (see actions.ts).

// Reads the DB per request; must never be prerendered.
export const dynamic = 'force-dynamic';

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

const VERDICT_COPY: Record<string, { title: string; detail: string }> = {
  already_welcomed: {
    title: 'Already introduced',
    detail:
      'A welcome (or an earlier operator resend) was delivered to this person. The welcome is once-per-person, ever — resending would introduce Capo twice.',
  },
  marked_known: {
    title: 'Marked as already knowing Capo',
    detail:
      'This person has a skipped welcome row — 0033’s backfill marked everyone who existed when the welcome shipped as already introduced. There is no failure to repair here.',
  },
  never_attempted: {
    title: 'The sweep has not tried yet',
    detail:
      'No welcome was ever attempted for this person. The sweep runs every fifteen minutes (Lisbon 09–19) and will welcome them on its own; an operator send now would race it.',
  },
  sweep_will_retry: {
    title: 'Capo is still retrying this itself',
    detail:
      'The newest failure has a retryable error code, and the attempt cap (3) is not spent — the sweep retries once a day on its own (issue #121). Resending now could mean a second welcome tomorrow. Come back if it exhausts its attempts.',
  },
  unreadable: {
    title: 'Ledger not readable',
    detail: 'A ledger row for this person has a status this screen does not recognise. Refusing rather than guessing.',
  },
  sweep_exhausted: {
    title: 'Resend available — the sweep gave up',
    detail: 'All automatic attempts (3) failed. Nothing will retry this person again except this button.',
  },
  sweep_gave_up: {
    title: 'Resend available — the sweep classified this as permanent',
    detail:
      'The last failure’s error is one the sweep never retries (an unknown error, or a permanent code like 131026 “not on WhatsApp”). If the underlying problem — usually the phone number — has since been fixed, this button is the only path left.',
  },
  stuck_claim: {
    title: 'Resend available — but the original may have arrived',
    detail:
      'A welcome claim is stuck at “pending”: the cron died mid-send, and that claim blocks the sweep forever. Meta may or may not have accepted the original before the crash — resending can therefore introduce Capo twice. Only you can judge.',
  },
};

const RESULT_COPY: Record<string, { tone: 'success' | 'danger'; text: string }> = {
  sent: { tone: 'success', text: 'Sent. Meta accepted the message; delivery callbacks will stamp the row below.' },
  already_today: {
    tone: 'danger',
    text: 'Nothing sent — an operator resend for this person was already attempted today (one per person per day).',
  },
  refused_consent: { tone: 'danger', text: 'Nothing sent — no recorded WhatsApp opt-in at send time.' },
  refused_unreachable: { tone: 'danger', text: 'Nothing sent — no usable address at send time.' },
  refused_verdict: { tone: 'danger', text: 'Nothing sent — the ledger changed and the resend is no longer allowed.' },
  refused_env: {
    tone: 'danger',
    text: 'Nothing sent — this deployment has no WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID. Add both to the operator project in Vercel.',
  },
  claim_failed: { tone: 'danger', text: 'Nothing sent — the ledger claim could not be written.' },
};

function readResult(raw: string | undefined): { tone: 'success' | 'danger'; text: string } | null {
  if (!raw) return null;
  if (raw.startsWith('failed:')) {
    return {
      tone: 'danger',
      text: `The send failed and was recorded as failed: ${decodeURIComponent(raw.slice('failed:'.length))}`,
    };
  }
  return RESULT_COPY[raw] ?? null;
}

export default async function ResendWelcomePage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string; audience: string; personId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { companyId, audience: audienceRaw, personId } = await params;
  const { result } = await searchParams;

  if (audienceRaw !== 'worker' && audienceRaw !== 'manager') {
    return <p className="text-sm text-fg-muted">Unknown audience.</p>;
  }
  const audience = audienceRaw as ResendAudience;

  const ctx = await loadWelcomeResendContext(companyId, audience, personId);
  if (!ctx) {
    return (
      <p className="text-sm text-fg-muted">
        Unknown company or person.{' '}
        <Link href="/companies" className="underline">
          Back to companies
        </Link>
      </p>
    );
  }

  const verdictCopy = VERDICT_COPY[ctx.verdict.reason];
  const resultBanner = readResult(result);
  const canSend = ctx.verdict.allowed && ctx.consent && ctx.recipient !== null;
  const billingOk = ctx.company.subscription_status === 'trialing' || ctx.company.subscription_status === 'active';

  return (
    <div className="max-w-2xl space-y-6">
      <section className="space-y-1">
        <h1 className="text-lg font-semibold">Resend welcome — {ctx.personName}</h1>
        <p className="text-xs text-fg-muted">
          {ctx.company.name} · {audience} ·{' '}
          <Link href={`/companies/${companyId}`} className="underline hover:text-fg">
            back to company →
          </Link>
        </p>
      </section>

      {resultBanner && (
        <p
          className={`rounded-lg border p-3 text-sm ${
            resultBanner.tone === 'success' ? 'border-success bg-success-quiet' : 'border-danger bg-danger-quiet'
          }`}
        >
          {resultBanner.text}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Gates, checked now</h2>
        <ul className="space-y-1 text-sm">
          <li className={ctx.consent ? 'text-success' : 'text-danger'}>
            {ctx.consent
              ? '✓ WhatsApp opt-in on record'
              : '✗ No recorded opt-in — nothing proactive may be sent (0025). The manager records consent on /perfil.'}
          </li>
          <li className={ctx.recipient ? 'text-success' : 'text-danger'}>
            {ctx.recipient
              ? `✓ Reachable at ${describeRecipient(ctx.recipient)}`
              : '✗ No phone and no stored WhatsApp id — nowhere to send.'}
          </li>
          <li className={billingOk ? 'text-success' : 'text-warn'}>
            {billingOk
              ? `✓ Subscription: ${ctx.company.subscription_status}`
              : `⚠ Subscription is ${ctx.company.subscription_status} — this spends money on a tenant who is not paying. Not blocked; your call.`}
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{verdictCopy?.title ?? ctx.verdict.reason}</h2>
        <p className="text-sm text-fg-muted">{verdictCopy?.detail}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Welcome history</h2>
        {ctx.ledger.length === 0 ? (
          <p className="text-sm text-fg-muted">No welcome rows for this person.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs text-fg-muted">
                  <th className="py-2 pr-4 font-normal">When</th>
                  <th className="py-2 pr-4 font-normal">Kind</th>
                  <th className="py-2 pr-4 font-normal">Status</th>
                  <th className="py-2 pr-4 font-normal">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {ctx.ledger.map(row => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 whitespace-nowrap text-xs text-fg-muted">{formatWhen(row.created_at)}</td>
                    <td className="py-2 pr-4">{row.kind === 'welcome' ? 'Welcome (sweep)' : 'Operator resend'}</td>
                    <td className={`py-2 pr-4 ${row.status === 'failed' ? 'text-danger' : row.status === 'sent' ? 'text-success' : 'text-warn'}`}>
                      {row.status}
                    </td>
                    <td className="py-2 pr-4 text-xs text-fg-muted">{row.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Exactly what would be sent</h2>
        <p className="text-xs text-fg-muted">
          The approved <span className="font-mono">capo_welcome</span> template, language{' '}
          <span className="font-mono">{ctx.plan.languageCode}</span> — always the paid template, even if a free-form
          window happens to be open. The wrapper text is frozen at Meta’s approval; only the two parameters below are
          ours. Content is rendered fresh now, not replayed from the failed row.
        </p>
        <div className="rounded-lg border border-hairline p-3 text-sm whitespace-pre-line">{ctx.plan.renderedPreview}</div>
        <p className="text-xs text-fg-muted">
          {'{{1}}'} = <span className="font-mono">{ctx.plan.bodyParams[0]}</span> · {'{{2}}'} ={' '}
          <span className="font-mono">{ctx.plan.bodyParams[1]}</span>
        </p>
      </section>

      {canSend ? (
        <form action={resendWelcome} className="space-y-2">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="audience" value={audience} />
          <input type="hidden" name="personId" value={personId} />
          <button
            type="submit"
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-on-solid hover:bg-brand-hover"
          >
            Send now — one paid template to {describeRecipient(ctx.recipient!)}
          </button>
          <p className="text-xs text-fg-muted">
            Every check above is re-run at send time; at most one operator resend per person per day.
          </p>
        </form>
      ) : (
        <p className="rounded-lg border border-hairline p-3 text-sm text-fg-muted">
          Sending is not available: {!ctx.verdict.allowed ? 'the verdict above refuses it' : !ctx.consent ? 'no recorded opt-in' : 'no usable address'}.
        </p>
      )}
    </div>
  );
}
