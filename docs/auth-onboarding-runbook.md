# Auth + multi-tenancy — operator runbook

What ships in the code vs. what you (the operator) must do by hand in the
Supabase dashboard and on first deploy. Do these **once**, in order.

## 1. Supabase dashboard config (one-time)

**Auth → Providers → Email**
- Enable **Email** provider; enable **Magic Link** (email OTP). Passwords are
  unused.
- Turn **OFF** "Allow new users to sign up" (Auth → Providers → Email, or
  Auth → Settings depending on dashboard version). Pilot is invite-only. The
  app also passes `shouldCreateUser: false`, so this is belt-and-braces.

**Auth → URL Configuration**
- **Site URL** = the production Vercel URL (e.g. `https://capo.vercel.app`).
- **Redirect allow-list**: add `http://localhost:3000/**`, the production URL
  `/**`, and Vercel preview pattern `https://*-<team>.vercel.app/**`.

**Auth → Email Templates** — repoint both templates at our confirm route so
the SSR token_hash flow works (default templates use a different link shape):
- **Magic Link** template link →
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
- **Invite user** template link →
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`

**Auth → Settings (recommended while here)**
- Confirm **JWT signing** uses **asymmetric keys** (default for new projects).
  If symmetric, `getClaims()` silently falls back to a network `getUser()` per
  request — flip to asymmetric to keep verification local.
- Enable **Leaked password protection** (flagged by the security advisor;
  harmless for us since we don't use passwords, but clears the warning).

## 2. Environment variables (Vercel + local)

Already in `.env.local`; add the two public ones to Vercel (Production +
Preview + Development):

```
NEXT_PUBLIC_SUPABASE_URL=https://qdfmvhjrcmeoxbattnsm.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_0CJYE011Ohtx13NCyeiB6w_wpiq_R9t
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` stay as-is (system paths + n8n).

## 3. Invite the first user + adopt the seeded company

The seeded company (`7ec5e733-5fea-4fe6-a843-b496373f6c65` — 5 workers, 4 jobs,
11 tasks, its conversation + memories) must attach to Federico so nothing
orphans and he skips the fresh-company onboarding.

1. **Auth → Users → Invite user** → `ostanfederico@gmail.com`. He gets the
   invite email; the link lands on `/auth/confirm` and creates his
   `auth.users` row.
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

Every subsequent pilot manager is a normal invite: they land on
`/onboarding`, enter company name + phone, and `complete_onboarding()` creates
a fresh company + profile for them.

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

- **Email delivery**: Supabase built-in SMTP is rate-limited (~a few/hour) —
  fine for the 2-user pilot; wire Resend/Postmark custom SMTP before wider
  invites.
- Custom SMTP + asymmetric-key confirmation are the two things to double-check
  before onboarding real managers at volume.
