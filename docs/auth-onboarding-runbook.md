# Auth + multi-tenancy — operator runbook

What ships in the code vs. what you (the operator) must do by hand in the
Supabase dashboard and on first deploy. Do these **once**, in order.

## 1. Supabase dashboard config (one-time)

**Auth → Providers → Email**
- Enable **Email** provider (email + password login). Magic Link / email OTP
  is unused — no email templates, no confirm route, no token expiry to
  babysit.
- Turn **OFF** "Allow new users to sign up" (Auth → Providers → Email, or
  Auth → Settings depending on dashboard version). Pilot is invite-only. The
  app only ever calls `signInWithPassword` — there is no sign-up path in the
  code — so this is belt-and-braces.

**Auth → URL Configuration**
- **Site URL** = the production Vercel URL (e.g. `https://capo.vercel.app`).
  (Only relevant to auth emails, which the login flow no longer sends; set it
  anyway so any future password-reset email points at the right host.)

**Auth → Settings (recommended while here)**
- Confirm **JWT signing** uses **asymmetric keys** (default for new projects).
  If symmetric, `getClaims()` silently falls back to a network `getUser()` per
  request — flip to asymmetric to keep verification local.
- Enable **Leaked password protection** — we use real passwords now, so this
  is doing actual work (rejects passwords found in known breaches).

## 2. Environment variables (Vercel + local)

Already in `.env.local`; add the two public ones to Vercel (Production +
Preview + Development):

```
NEXT_PUBLIC_SUPABASE_URL=https://qdfmvhjrcmeoxbattnsm.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_0CJYE011Ohtx13NCyeiB6w_wpiq_R9t
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` stay as-is (system paths + n8n).

## 3. Create the first user + adopt the seeded company

The seeded company (`7ec5e733-5fea-4fe6-a843-b496373f6c65` — 5 workers, 4 jobs,
11 tasks, its conversation + memories) must attach to Federico so nothing
orphans and he skips the fresh-company onboarding.

1. **Auth → Users → Create new user** (the green "Add user" button, NOT
   "Invite user" — invites send an OTP email, which we no longer handle).
   Enter `ostanfederico@gmail.com`, set a password, and tick
   **Auto Confirm User** so no confirmation email is needed. This creates his
   `auth.users` row immediately. Share the password out-of-band (e.g. a
   message) — he can sign in at `/login` right away.
2. Once his auth row exists, bind it to the seeded company (SQL editor / MCP
   `execute_sql`):

   ```sql
   insert into profiles (id, company_id, full_name, phone)
   select id,
          '7ec5e733-5fea-4fe6-a843-b496373f6c65',
          'Federico',
          '+351913621087'
   from auth.users
   where email = 'ostanfederico@gmail.com';
   ```

   Now `requireAuth()` finds his profile → he goes straight to the app;
   `/onboarding` auto-skips. All seeded data is his.

Every subsequent pilot manager is the same "Create new user" flow (email +
password, auto-confirm, share the password out-of-band): on first login they
land on `/onboarding`, enter company name + phone, and `complete_onboarding()`
creates a fresh company + profile for them.

## 4. n8n — no change

The dispatch workflow (`LJu5bNaRL9gLpeQ0`) connects to Postgres as the
`postgres` role, which owns the tables and is RLS-exempt (we did not use
`FORCE ROW LEVEL SECURITY`). `dispatch_tasks_today` keeps returning every
company's workers; `dispatch_log` writes hit no policy. Verified after the RLS
rollout: the view returned rows for two distinct companies as `postgres`.

## 5. What the code enforces (for reviewers)

- **Tenant key**: `private.current_company_id()` derives company from the
  JWT (`auth.uid()` → `profiles`), never from client input. Every tenant table
  has `to authenticated` policies keyed on it (migration 0007).
- **Cross-table FK integrity** (migration 0009): triggers reject a task/
  proposal that references another company's worker/job/conversation — the
  gap RLS alone doesn't cover, and the one that would leak into the shared SMS
  feed.
- **Client split**: request path uses the RLS-scoped publishable-key client
  (`src/db/user-client.ts`); `getDb()` (service role) is system-only and no
  longer on any request path.
- **Verified** (2026-07-07): 24-check two-tenant isolation matrix + both
  adversarial cross-tenant attacks blocked at the query layer; logged-out `/`,
  `/hoje`, `POST /api/chat` gated (307/401); dashboards company-scoped in the
  running app.

## Known follow-ups (not blocking)

- **Password reset**: there is no self-serve "forgot password" flow — the
  operator resets passwords by hand in the dashboard (Auth → Users → … →
  Reset password). Fine for a 1-2 person pilot; build a reset flow (which
  brings back email delivery + custom SMTP) before onboarding managers at
  volume.
- Asymmetric-key JWT signing is the other thing to double-check before wider
  rollout.
