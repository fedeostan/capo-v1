import { redirect } from 'next/navigation';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { createUserClient } from './user-client';
import type { Db } from './client';

// The per-request identity resolution: JWT (verified locally by getClaims)
// → profile → company_id. Every page and API route goes through here — the
// tenant is NEVER inferred from "first company" or from client input.

export interface AuthContext {
  db: Db; // user-scoped, RLS-enforced
  userId: string;
  companyId: string;
  /** profiles.language — what Capo SPEAKS to this person, and what the UI renders in. */
  locale: Locale;
  /** companies.language — what Capo STORES (task titles, job names, memories). */
  companyLocale: Locale;
}

export type AuthState =
  | { status: 'unauthenticated' }
  | { status: 'no_profile'; db: Db; userId: string }
  | { status: 'ok'; ctx: AuthContext };

export async function getAuthState(): Promise<AuthState> {
  const db = await createUserClient();
  const { data } = await db.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return { status: 'unauthenticated' };

  // RLS restricts profiles to the own row; maybeSingle → null means the user
  // is authenticated but not onboarded yet. The companies embed rides along on
  // the same request — companies_select_own already scopes it to this tenant,
  // so both language dials cost zero extra round-trips.
  const { data: profile } = await db
    .from('profiles')
    .select('company_id, language, company:companies(language)')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) return { status: 'no_profile', db, userId };

  return {
    status: 'ok',
    ctx: {
      db,
      userId,
      companyId: profile.company_id,
      // coerce, never trust: a row written under a locale we later retire must
      // degrade to the default rather than crash every render for that user.
      locale: coerceLocale(profile.language),
      companyLocale: coerceLocale(profile.company?.language),
    },
  };
}

// For pages: resolves or redirects. Never wrap this in try/catch — redirect()
// works by throwing.
export async function requireAuth(): Promise<AuthContext> {
  const state = await getAuthState();
  if (state.status === 'unauthenticated') redirect('/login');
  if (state.status === 'no_profile') redirect('/onboarding');
  return state.ctx;
}

// For API route handlers: resolves or null — the route answers 401 itself
// (redirects are wrong for fetch/XHR callers).
export async function getApiAuth(): Promise<AuthContext | null> {
  const state = await getAuthState();
  return state.status === 'ok' ? state.ctx : null;
}
