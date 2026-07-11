import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Db } from './client';
import type { Database } from './types';

// The user-scoped client: publishable key + the caller's session cookie, so
// every query runs under RLS as that user. This is the client for EVERYTHING
// on the request path (chat, dashboard, proposals, transcription) — the
// service-role client in client.ts is reserved for system paths.
//
// Per request by design (Fluid compute shares module scope across concurrent
// requests — a cached client would leak one user's session to another).
export async function createUserClient(): Promise<Db> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set in .env.local',
    );
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only —
          // safe to ignore because the proxy refreshes sessions.
        }
      },
    },
  });
}
