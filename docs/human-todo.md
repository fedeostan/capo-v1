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
