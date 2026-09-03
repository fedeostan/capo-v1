import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { renderEmail, type RenderedEmail } from './shell';

/**
 * "Confirm your email" — the one email a new manager MUST receive and open, so
 * it is the highest-stakes copy in the product. Sent on signup and by the
 * resend button on /confirmar-email.
 *
 * `link` is built by sendAuthEmail from generateLink's `properties.hashed_token`
 * and is already in the shape /auth/confirm verifies. Nothing here inspects it;
 * this module only renders. Keeping it that way is what lets
 * scripts/email-check.mts assert the rendering with no credentials.
 *
 * Ported from docs/emails/confirm-email.html and .txt (issue #113), which were
 * deleted when sending moved into the app.
 */
export function renderConfirmEmail({
  locale,
  link,
}: {
  locale: Locale;
  link: string;
}): RenderedEmail {
  const t = getCatalog(locale).auth.emails;
  return renderEmail(
    locale,
    {
      subject: t.confirm.subject,
      preview: t.confirm.preview,
      heading: t.confirm.heading,
      body: t.confirm.body,
      button: t.confirm.button,
      fallback: t.confirm.fallback,
      footer: t.confirm.footer,
    },
    link,
    (other) => getCatalog(other).auth.emails.confirm.otherLine,
  );
}
