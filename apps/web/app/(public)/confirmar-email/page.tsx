import type { Metadata } from 'next';
import Link from 'next/link';
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
        <h1 className="text-2xl font-semibold">{copy.title}</h1>
        {/* Naming the address is the typo check: "we sent it to jaoo@…" is the
            only way somebody spots that they mistyped their own email. */}
        <p className="text-sm text-zinc-500">
          {email ? copy.sentTo({ email }) : copy.sentToUnknown}
        </p>
      </div>

      {blocked && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {copy.blockedNotice}
        </p>
      )}

      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-600 text-xs font-semibold text-white">
              {index + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>

      <p className="text-sm text-zinc-500">{copy.thenWhat}</p>

      {params.reenviado === '1' && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-800 dark:text-emerald-300">
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
          <button
            type="submit"
            className="w-full rounded-lg border border-zinc-500/30 py-2.5 text-sm font-semibold hover:bg-zinc-500/10"
          >
            {copy.resend}
          </button>
        </form>
      )}

      {/* Both escapes are plain text below the instructions, deliberately. The
          old screen's ONLY call to action was "already confirmed? sign in
          here", which read as "continue" and walked people straight into the
          wrong-password dead end. */}
      <div className="space-y-2 text-center text-sm text-zinc-500">
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
