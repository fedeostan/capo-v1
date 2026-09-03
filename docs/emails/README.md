# The emails Capo sends

**Sending moved into the app.** The two account emails are no longer pasted
into anybody's dashboard: Capo renders them itself and hands them to Resend.
This folder no longer holds them.

| Email | Where it lives now |
|---|---|
| Confirm signup (also the resend on `/confirmar-email`) | `apps/web/lib/emails/confirm.ts` |
| Reset password (from `/recuperar`) | `apps/web/lib/emails/reset.ts` |
| Shared card layout, colours, plain-text twin | `apps/web/lib/emails/shell.ts` |
| The copy, in all three languages | `packages/i18n` → `auth.emails` |
| Who sends, when, and the throttle | `apps/web/lib/auth-email.ts` |
| The gate that keeps it honest | `scripts/email-check.mts` (`pnpm email-check`, in CI) |

| Still here | What it is | Status |
|---|---|---|
| `trial-ending.html` / `.txt` | "Trial ending soon" | **DRAFT, wired to nothing.** Needs a scheduled job and a product decision before anything sends it. Never was a Supabase template. |

## Why it moved (issue #113, then W1)

#113 wrote two careful templates and a procedure for pasting them into
Supabase's dashboard. The procedure was never carried out, and while it sat
undone the DEFAULT Supabase template kept going out. That default routes the
click through Supabase's own `/auth/v1/verify`, which consumes the token,
confirms the account, and *then* forwards to `/auth/confirm` with no
`token_hash` — so the app answered **"O link expirou ou já foi usado"** to
people whose accounts had just been confirmed perfectly well. Their password
worked. The app said the link was dead.

That bug was only ever possible because a third party got to rewrite our link
in between. Capo builds the link itself now, so it cannot come back
(`/auth/confirm` also now validates its `next` destination against its own
origin before redirecting there — see `apps/web/lib/safe-next.ts` — which
closes a separate, unrelated redirect issue in the same route):

```
{siteUrl}/auth/confirm?token_hash={hashed_token}&type={signup|magiclink|recovery}&next={/onboarding|/nova-password}
```

The token still comes from Supabase — `auth.admin.generateLink()` mints one
without sending anything — so GoTrue remains the only authority on identity.
All that moved is the envelope. Use `properties.hashed_token`, never
`properties.action_link`: `action_link` **is** the `/auth/v1/verify` URL that
caused the bug.

## What the move bought

**The reader's language comes first.** A Go template running inside GoTrue
cannot know who is reading it (`profiles.language` does not exist yet at
signup), so #113's templates stacked all three languages in every message. The
app knows: the public pages already resolve a locale from the LanguageSwitch
cookie, then `Accept-Language`. So the reader's language is rendered fully and
the other two get one line each under a divider. Nobody loses a language.

**A plain-text part.** Supabase's dashboard takes one HTML body and has no
text field, which is why #113's `.txt` files were a copy reference that nothing
could send. Resend takes both parts, so they are sent now — built by
`shell.ts` from the same catalog strings, which is what stops the two halves
drifting.

**A throttle we control.** GoTrue's rate limits went with GoTrue's mailer, and
`/registar` and `/recuperar` are unauthenticated forms that cause mail to be
delivered to an arbitrary address. Migration `0045` adds `auth_email_sends`;
at most three account emails per address per hour, counted across all three
kinds together. See `AUTH_EMAIL_MAX_PER_WINDOW`.

## Design decisions carried over unchanged from #113

**Colours are hardcoded light-theme hex from `packages/ui/src/tokens.css`** —
email clients cannot read CSS variables. The hex-to-token mapping is in
`shell.ts`'s header. No dark-mode styles: dark mode in email is unreliable
across clients and was deliberately left out.

**Tables plus inline styles**, one column, max-width 480px, one full-width
button with a tap target of at least 48px. Managers read these on a phone.

**No images.** The wordmark is text. Images are blocked by default in many mail
clients, and a blocked logo as somebody's first impression is worse than no
logo.

## Operator notes

- **`RESEND_API_KEY` must be set on the Vercel project.** Until it is,
  `sendAuthEmail` falls back to the old Supabase mailer and logs
  `auth_email.legacy_mailer` — the app keeps working, but the emails are the
  generic ones again. The fallback function is marked for deletion in
  `apps/web/lib/auth-email.ts`. Locally the same key is read from
  `apps/web/.env.local` under its older name `RESEND_SMTP_KEY`.
- **Nothing needs pasting into Supabase's dashboard any more.** The "Confirm
  signup" and "Reset password" template fields and the custom-SMTP settings are
  no longer read by any code path. Leaving them configured is harmless.
- **Supabase's Site URL still matters**, for the redirect allow-list rather
  than for the template: `generateLink`'s `redirectTo` must be an allowed
  redirect URL. Authentication → URL Configuration must include
  `https://www.construcapo.com/auth/confirm` and `.../auth/callback`.
- **Resend's click and open tracking must stay OFF** for this domain. Click
  tracking rewrites every link through a Resend redirect, which for an auth
  link means a stranger-looking URL and another point of failure in the one
  email a person needs to get into the product.
- **The Resend key is scoped to sending only, this domain only.** If it leaks
  it cannot read data or manage the account, only send mail as
  construcapo.com. Still worth rotating immediately.
