'use server';

import { requireAuth } from '@capo/db/session';
import { logEvent } from '@/lib/log';

/**
 * Has this manager's first WhatsApp message reached Capo yet — and, the moment
 * it has, record the morning-briefing permission they chose on the way in.
 * Issue #84.
 *
 * ── Why last_inbound_at is honest evidence ────────────────────────────────
 * `profiles.last_inbound_at` (migration 0030) is written by exactly one thing:
 * `stampLastInbound` in apps/web/app/api/whatsapp/route.ts, on a webhook
 * delivery whose sender Capo already resolved to THIS profile. So a value here
 * is proof of a complete round trip — the right number, reaching the right
 * account — and not merely that something was sent. Nothing else in the schema
 * answers that question: `messages` records turns, not deliveries, and
 * notification_log is the OUTBOUND ledger.
 *
 * ── Why the consent write lives here ──────────────────────────────────────
 * `whatsapp_opt_in_at` / `whatsapp_opt_out_at` are what hasWhatsAppConsent()
 * reads and what the 07:00 briefing fails CLOSED on. Writing them on page load
 * would manufacture consent out of a pre-ticked default, and writing them on
 * the button tap would leave every desktop signup with nothing, because the QR
 * path has no tap at all. Arrival is the one event both devices share, and it
 * is the strongest evidence this screen can ever have: they really did open a
 * WhatsApp thread with Capo, from their own device.
 */
export interface ArrivalState {
  arrived: boolean;
}

export async function checkWhatsAppArrival(optIn: boolean): Promise<ArrivalState> {
  // RLS, never getDb(). One row, the caller's own, under profiles_select_own /
  // profiles_update_own — the tenant boundary on this path is the same one
  // every page uses, and requireAuth() redirects rather than answering if the
  // session died mid-wait.
  const { db, userId, companyId } = await requireAuth();

  // Naming the column is safe here in a way it would not be in getAuthState:
  // 0030 is verified applied in production, and a 42703 on THIS query costs one
  // screen's confirmation rather than every authenticated page in the product.
  // It is logged for the same reason — the symptom of a missing column is a
  // manager who is told "still nothing" after a message that arrived perfectly,
  // and that must be greppable.
  const { data, error } = await db
    .from('profiles')
    .select('last_inbound_at, whatsapp_opt_in_at, whatsapp_opt_out_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logEvent('handshake.arrival_read_failed', { companyId, userId, error: error.message });
    return { arrived: false };
  }
  if (!data?.last_inbound_at) return { arrived: false };

  // Record ONCE, never overwrite. Without this guard: a manager unticks the
  // box, sends the message, taps "Fazer isto mais tarde" before the 3s poll
  // fires (nothing recorded yet — correct), then presses Back. /whatsapp
  // remounts with the tick-box reset to its `useState(true)` default, the poll
  // sees `last_inbound_at` already set, and writes `whatsapp_opt_in_at = now()`
  // — silently reversing an explicit opt-out. The same remount-and-overwrite
  // would also stomp a choice just made on /perfil, since this screen's own
  // "Corrigir o número" link sends them there and back. A visit where
  // `last_inbound_at` was ALREADY set is also, per the design spec, not an
  // act at all — the tick-box state at that moment is a stale default, not a
  // decision. So: once either timestamp exists, this action leaves consent
  // alone and /perfil remains the only way to change it.
  const alreadyRecorded = data.whatsapp_opt_in_at != null || data.whatsapp_opt_out_at != null;

  if (alreadyRecorded) {
    logEvent('handshake.arrived', { companyId, userId, optIn, consentAlreadyRecorded: true });
    return { arrived: true };
  }

  // Marks, never clears — the two timestamps are compared and the later wins,
  // so withdrawing consent does not erase the record that it was once given.
  // Same shape as setWhatsAppConsent on /perfil. See 0025_whatsapp_optin.sql.
  const now = new Date().toISOString();
  const patch = optIn ? { whatsapp_opt_in_at: now } : { whatsapp_opt_out_at: now };
  const { error: consentError } = await db.from('profiles').update(patch).eq('id', userId);
  if (consentError) {
    // Swallowed deliberately: a failed consent write must not cost the manager
    // their confirmation, and the fail-closed direction (no recorded opt-in, no
    // proactive send) is the safe one. They can still tick the box on /perfil.
    logEvent('handshake.consent_write_failed', { companyId, userId, optIn, error: consentError.message });
  }

  logEvent('handshake.arrived', {
    companyId,
    userId,
    optIn,
    consentAlreadyRecorded: false,
    consentRecorded: !consentError,
  });
  return { arrived: true };
}

/**
 * The 90-second give-up is decided entirely in the browser (handshake.tsx's
 * own clock) and, unlike every other outcome on this screen, left no trace
 * server-side. "How many new managers are failing first contact?" is the
 * question this feature exists to expose, so record it — one event, no
 * retries, swallowed on failure so a logging hiccup can never surface as a
 * broken screen for someone who has already had a bad signup experience.
 */
export async function reportHandshakeStalled(): Promise<void> {
  const { userId, companyId } = await requireAuth();
  try {
    logEvent('handshake.stalled', { companyId, userId });
  } catch {
    // Swallowed deliberately — see the doc comment above.
  }
}
