import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export type Db = SupabaseClient<Database>;

let client: Db | undefined;

// Server-only: uses the service-role key (RLS is deny-all for anon access).
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
