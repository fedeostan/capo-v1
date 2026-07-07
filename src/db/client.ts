import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export type Db = SupabaseClient<Database>;

let client: Db | undefined;

// Server-only SYSTEM client: the service-role key bypasses RLS entirely.
// Nothing on the user request path may use this — chat, dashboard, proposals
// and transcription all run on the RLS-scoped client from user-client.ts.
// getDb() exists for system paths that legitimately act across tenants:
// operator scripts and the future Execution Agents / dispatch seam. (The n8n
// dispatch is external and connects to Postgres directly.)
export function getDb(): Db {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
    }
    client = createClient<Database>(url, key, { auth: { persistSession: false } });
  }
  return client;
}
