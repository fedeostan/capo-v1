# Human TODO — Capo upgrade (2026-07-13)

Items only Federico can do (external accounts, dashboards, physical devices).
Populated phase by phase as `docs/plans/2026-07-13-capo-upgrade.md` executes;
the final, complete list lands in Phase 8.

## Phase 4 — Auth (self-serve signup, password reset, Google OAuth)

1. **Supabase dashboard → Authentication → Providers → Email**: enable "Allow
   new users to sign up". Until this is on, `/registar` shows "Os registos
   abrem em breve" for every signup attempt (env-gated failure mode, by
   design — the app deploys and works before this toggle is flipped).
2. **Supabase dashboard → Authentication → Emails**: configure production
   SMTP (the default Supabase email sender is rate-limited and not meant for
   production volume) and set EU-PT copy for the "Confirm signup" and "Reset
   password" templates.
3. **Supabase dashboard → Authentication → URL Configuration**: set Site URL
   to the production domain once known, and add
   `https://<prod>/auth/confirm` and `https://<prod>/auth/callback` to
   Additional Redirect URLs (needed for `emailRedirectTo` /
   `resetPasswordForEmail` redirects to be accepted).
4. **Google OAuth (optional)**: create a GCP OAuth consent screen + OAuth
   client (authorized redirect URI = the Supabase project's callback URL,
   shown in Supabase dashboard → Authentication → Providers → Google) → paste
   the client id/secret into the Supabase Google provider → set
   `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=1` in Vercel (production env) → redeploy.
   Until this env var is set, the "Entrar com Google" button simply doesn't
   render — no broken UI, no dead link.

## Phase 5 — Stripe billing (€45/mo, 14-day trial)

1. **Stripe**: create an account (or use an existing one) → create Product
   "Capo" with a recurring Price of €45/mo EUR → copy the Price id
   (`STRIPE_PRICE_ID`) and the account's secret key (`STRIPE_SECRET_KEY`) →
   set both in Vercel (production env, project `capo-v1`).
2. **Stripe → Webhooks**: add an endpoint `https://<prod>/api/stripe/webhook`
   subscribed to `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` → copy the signing secret
   (`STRIPE_WEBHOOK_SECRET`) into Vercel → redeploy.
3. **Verify**: run one Stripe test-mode checkout end to end (Assinar on
   `/subscricao` → Stripe Checkout → back to the app) and confirm the
   company's `subscription_status` flips to `active` in Supabase.
   Until steps 1–3 are done, billing is fully disabled app-wide (no
   `STRIPE_SECRET_KEY` → `/subscricao` shows "faturação ainda não
   disponível", the webhook 503s, and no write path is ever gated) — the app
   ships and works correctly before any of this exists.
