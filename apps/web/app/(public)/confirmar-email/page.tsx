import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@capo/ui/button';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import { readPendingEmail } from '@/lib/pending-email';
import { resendConfirmation } from './actions';

// The instruction screen for "your account is not usable until you open the
// email" (issue #99). TWO entrances, one screen:
//   - straight after /registar, and
//   - after a sign-in attempt that failed ONLY because the email was never
//     confirmed, which used to be answered with "wrong email or password".
// The second entrance is the whole point: the people in the issue never saw
// the first screen as an instruction, went to sign in, and were told their
// password was wrong. Sending them here instead answers the question they
// actually have.

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.auth.confirmEmail.title) };
}

export default async function ConfirmarEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ pendente?: string; reenviado?: string }>;
}) {
  const params = await searchParams;
  const { t } = await publicCatalog();
  const copy = t.auth.confirmEmail;
  const email = await readPendingEmail();
  const blocked = params.pendente === '1';
  const steps = [copy.step1, copy.step2, copy.step3];

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">📬</p>
        <h1 className="text-title font-semibold">{copy.title}</h1>
        {/* Naming the address is the typo check: "we sent it to jaoo@…" is the
            only way somebody spots that they mistyped their own email. */}
        <p className="text-callout text-fg-muted">
          {email ? copy.sentTo({ email }) : copy.sentToUnknown}
        </p>
      </div>

      {blocked && (
        <p className="rounded-lg bg-warn-quiet px-3 py-2 text-callout text-warn">
          {copy.blockedNotice}
        </p>
      )}

      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-callout">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-caption font-semibold text-on-brand">
              {index + 1}
            </span>
            {/* leading-6 lines the first text line up with the 24px circle
                beside it, without off-scale padding. */}
            <span className="leading-6">{step}</span>
          </li>
        ))}
      </ol>

      <p className="text-callout text-fg-muted">{copy.thenWhat}</p>

      {params.reenviado === '1' && (
        <p className="rounded-lg bg-success-quiet px-3 py-2 text-center text-callout text-success">
          {copy.resent}
        </p>
      )}

      {/* No button when the cookie has expired: there would be no address to
          send to, and a button that quietly does nothing is worse than none.
          The "wrong email" link below still works — signing up again with the
          same address resends the confirmation. */}
      {email && (
        <form action={resendConfirmation}>
          {blocked && <input type="hidden" name="pendente" value="1" />}
          <Button type="submit" variant="secondary" fullWidth>
            {copy.resend}
          </Button>
        </form>
      )}

      {/* Both escapes are plain text below the instructions, deliberately. The
          old screen's ONLY call to action was "already confirmed? sign in
          here", which read as "continue" and walked people straight into the
          wrong-password dead end. */}
      <div className="space-y-2 text-center text-callout text-fg-muted">
        <p>
          <Link href="/registar" className="underline">
            {copy.wrongEmail}
          </Link>
        </p>
        <p>
          <Link href="/login" className="underline">
            {copy.alreadyConfirmed}
          </Link>
        </p>
      </div>
    </div>
  );
}
