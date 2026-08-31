# The emails Capo sends (issue #113)

This folder is the **source of truth** for Capo's email templates. Supabase's
dashboard holds a pasted *copy* of two of them; if the copy and this folder
ever disagree, this folder wins — fix the dashboard, not the file.

| File | What it is | Status |
|---|---|---|
| `confirm-email.html` / `.txt` | "Confirm signup" — sent on signup and by the resend button on `/confirmar-email` | Ready to paste into Supabase |
| `password-reset.html` / `.txt` | "Reset password" — sent from `/recuperar` | Ready to paste into Supabase |
| `trial-ending.html` / `.txt` | "Trial ending soon" | **DRAFT — wired to nothing.** Needs a scheduled job and a product decision before anything sends it. Not a Supabase template. |

Deliberately **not** in `@capo/i18n`: the catalogs there hold copy the app
renders at runtime. Nothing in the app renders these strings — they are pasted
into Supabase's dashboard, whose Go templates cannot import from this repo —
so catalog entries would be dead weight that drifts. The files here are the
single copy instead.

## Decisions baked into these templates

**One template, three languages stacked.** Supabase Auth sends ONE template
per email type, and its template variables (`{{ .TokenHash }}`, `{{ .SiteURL }}`,
…) carry no locale — at send time the template cannot know whether the reader
speaks Portuguese, Spanish or English (`profiles.language` does not even exist
yet at signup). So each email carries Portuguese first and fullest, then a
one-sentence Spanish section and a one-sentence English section below a
divider. The alternative — per-language templates — needs sending to move out
of Supabase Auth entirely (e.g. an auth hook calling Resend's API), which is a
bigger piece of work and a follow-up, not this pass.

**The link shape is load-bearing, not cosmetic.** The app's confirm route
(`apps/web/app/auth/confirm/route.ts`) verifies `{token_hash, type}` from the
query string and then redirects to `next`. Supabase's default template
variable `{{ .ConfirmationURL }}` does **not** produce that shape — it routes
the click through Supabase's own `/auth/v1/verify` endpoint, which lands on
our route without a `token_hash`, and the app answers "O link expirou ou já
foi usado". The links in these templates must stay exactly:

```
Confirm:  {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding
Reset:    {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/nova-password
```

`type` and `next` here mirror what the app itself passes as `emailRedirectTo`
in `registar/actions.ts`, `confirmar-email/actions.ts` and
`recuperar/actions.ts`. `{{ .SiteURL }}` is Supabase's **Site URL** setting
(Authentication → URL Configuration) — it must name
`https://www.construcapo.com` or every link in every email points at the
wrong host. That is step 1 of the paste procedure for a reason.

**Colours are hardcoded hex from `packages/ui/src/tokens.css`** (light theme
values — email clients cannot read CSS variables). Each `.html` file lists the
hex → token mapping in its header comment. No dark-mode styles: dark mode in
email is unreliable across clients and was explicitly left out of this pass.
Tables + inline styles throughout, one column, max-width 480px, one full-width
button with a ≥48px tap target — managers read these on a phone.

**No images.** The wordmark is text. Images are blocked by default in many
mail clients, and a blocked logo as the first impression is worse than no logo.

## Paste procedure (Supabase dashboard)

Do these in order. Until step 4 is done, Supabase's built-in sender keeps
working — nothing here half-configures anything.

1. **Authentication → URL Configuration.** Site URL =
   `https://www.construcapo.com`. Additional Redirect URLs must include
   `https://www.construcapo.com/auth/confirm` and
   `https://www.construcapo.com/auth/callback`. (Long-flagged in
   `docs/human-todo.md` §2.3 — the templates depend on it via `{{ .SiteURL }}`.)
2. **Authentication → Emails → Templates → "Confirm signup".** Subject:
   `Confirma o teu email · Capo`. Message body: the entire contents of
   `confirm-email.html`.
3. **Same place → "Reset password".** Subject:
   `Recupera a tua palavra-passe · Capo`. Message body: the entire contents of
   `password-reset.html`.
4. **Authentication → Emails → SMTP Settings** (on some dashboard versions:
   Project Settings → Authentication → SMTP). Enable custom SMTP with:
   - Sender email: `ola@construcapo.com`
   - Sender name: `Capo`
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the Resend API key — it lives as `RESEND_SMTP_KEY` in
     `apps/web/.env.local` on Federico's machine. **Never commit it, never
     paste it anywhere but this dashboard field.**
5. **Test:** sign up with a throwaway address on `/registar`, receive the
   confirm email, click through to `/onboarding`. Then `/recuperar` for the
   reset email. Supabase's own rate limits stop applying once custom SMTP is
   on (Authentication → Rate Limits, raise if needed).

Notes:

- The dashboard takes **one HTML body per template — there is no plain-text
  field.** The `.txt` files are the canonical copy reference and are ready for
  the day sending moves to Resend's API (which does take both parts). Known
  gap, stated rather than hidden.
- Resend's **click and open tracking must stay OFF** for this domain (they are
  off today). Click tracking rewrites every link through a Resend redirect —
  for an auth link that means a stranger-looking URL and another point of
  failure in the one email a person needs to get into the product.
- The Resend API key is scoped to *sending only, this domain only* — if it
  leaks it cannot read data or manage the Resend account, only send mail as
  construcapo.com (still worth rotating immediately if that happens).
