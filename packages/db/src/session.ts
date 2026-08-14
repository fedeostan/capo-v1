import { redirect } from 'next/navigation';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { coerceConfirmPosture, type ConfirmPosture } from './posture';
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
  /**
   * profiles.confirm_posture (0031) — does a mutating instruction from this
   * person act immediately, or raise an approval card first?
   *
   * Resolved HERE, on the request path, rather than inside the guard: the guard
   * must stay a pure, synchronous decision over evidence it was handed. A
   * database read inside it would make every write depend on a second round
   * trip that can fail, and "the posture lookup errored" has no safe answer
   * that is not just this default again.
   */
  confirmPosture: ConfirmPosture;
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
  //
  // `*` rather than a column list since 0031, and for the deploy-ordering
  // reason in AGENTS.md: this query runs on EVERY authenticated page and route,
  // so naming `confirm_posture` here would take the entire app down for the
  // minutes between a deploy and its migration. With `*` the field is simply
  // absent until the column exists, and coerceConfirmPosture reads that as the
  // safe posture. One row, own row only — the extra columns cost nothing.
  const { data: profile } = await db
    .from('profiles')
    .select('*, company:companies(language)')
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
      // Same coerce-never-trust stance as the two locales above, and it fails
      // to always_ask: see DEFAULT_CONFIRM_POSTURE.
      confirmPosture: coerceConfirmPosture(profile.confirm_posture),
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
