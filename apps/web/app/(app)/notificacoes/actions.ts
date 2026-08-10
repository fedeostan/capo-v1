'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth } from '@capo/db/session';
import { logEvent } from '@/lib/log';

// The only write this feature exposes to the tenant, and the grant layer
// already narrows it to one column: 0022 gives `authenticated`
// `grant update (read_at)` and nothing else, so even a hostile client can
// only ever move this flag. RLS narrows the rows to this profile's own.
//
// Deliberately NOT behind assertNotBlocked, unlike every domain write. A
// lapsed subscription blocks changing the site's data; it must not trap the
// manager behind a badge they can never clear. Reading your own notifications
// is not a billable action.

/** Refresh the shell strip, which renders above every authenticated screen.
 *  'layout' from '/' because the count lives in (app)/layout.tsx, not in any
 *  one page — revalidating '/notificacoes' alone would leave the strip on
 *  every other tab showing a count that is no longer true. */
function revalidateShell(): void {
  revalidatePath('/', 'layout');
}

/**
 * Clear the badge. Scoped to rows that are actually unread so a double tap is
 * a no-op rather than rewriting every read_at in the inbox — the timestamp is
 * a record of when the manager first saw something, and overwriting it would
 * quietly destroy that.
 */
export async function markAllRead(): Promise<void> {
  const { db, userId, companyId } = await requireAuth();

  const { error } = await db
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('profile_id', userId)
    .is('read_at', null);
  if (error) throw new Error(`notifications.mark_all_read failed: ${error.message}`);

  logEvent('notifications.mark_all_read', { companyId });
  revalidateShell();
}
