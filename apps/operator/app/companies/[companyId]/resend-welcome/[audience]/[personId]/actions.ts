'use server';

import { redirect } from 'next/navigation';
import { getDb } from '@capo/db/client';
import { sendWhatsAppTemplate } from '@capo/core/channels/whatsapp';
import { loadWelcomeResendContext, type ResendAudience } from '../../../../../data';
import { OPERATOR_RESEND_WELCOME_KIND } from '../../../../../welcome-resend';

// The one write path in the operator app (issue #123, part A): send one
// person the capo_welcome template, on the operator's explicit say-so, and
// record it in notification_log under the operator's own kind.
//
// Reached only as a form POST from the preview page, which the basic-auth
// proxy gates like every other request here (proxy.ts matches everything but
// Next internals — server-action POSTs included).
//
// EVERY input is re-derived at send time. The page that rendered the button
// is a snapshot; consent, the address, the ledger and the verdict are read
// again inside this action, and any of them saying no wins over what the
// operator was looking at. Same claim-before-send protocol as the crons: the
// ledger row is the lock, 23505 means someone (or a double click) got there
// first today, and a claim is resolved to 'sent' or 'failed' but never
// deleted.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function resendWelcome(formData: FormData): Promise<void> {
  const companyId = String(formData.get('companyId') ?? '');
  const audienceRaw = String(formData.get('audience') ?? '');
  const personId = String(formData.get('personId') ?? '');

  if (!UUID.test(companyId) || !UUID.test(personId) || (audienceRaw !== 'worker' && audienceRaw !== 'manager')) {
    // A malformed POST has no page to go back to; answering the companies list
    // beats a 500 with a uuid in it.
    redirect('/companies');
  }
  const audience = audienceRaw as ResendAudience;
  const back = (result: string) =>
    redirect(`/companies/${companyId}/resend-welcome/${audience}/${personId}?result=${result}`);

  const ctx = await loadWelcomeResendContext(companyId, audience, personId);
  if (!ctx) redirect('/companies');

  // The gates, in the order the preview explains them. Consent first: it is
  // the legal one, it fails closed, and nothing may outrank it (0025).
  if (!ctx.consent) back('refused_consent');
  if (!ctx.recipient) back('refused_unreachable');
  if (!ctx.verdict.allowed) back('refused_verdict');

  // Env read lazily, never at module scope (build-time secrets rule). The
  // operator deploy needs WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID —
  // the same pair apps/web holds — or this button refuses cleanly.
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) back('refused_env');

  const db = getDb();

  // THE CLAIM, before the Graph call — the same trade the crons make: a crash
  // mid-send costs this person today's resend rather than risking two. The
  // daily unique key makes a double click a 23505, not a double bill.
  const { data: claimed, error: claimError } = await db
    .from('notification_log')
    .insert({
      kind: OPERATOR_RESEND_WELCOME_KIND,
      company_id: companyId,
      audience,
      ...(audience === 'worker' ? { worker_id: personId } : { profile_id: personId }),
      notification_date: ctx.today,
      channel: 'whatsapp',
      status: 'pending',
      task_ids: [],
    })
    .select('id')
    .single();
  if (claimError) {
    if (claimError.code === '23505') back('already_today');
    console.error('operator.welcome_resend claim failed:', claimError.message);
    back('claim_failed');
  }

  let outcome: 'sent' | 'failed' = 'sent';
  let failureMessage: string | null = null;
  try {
    const { providerMessageId } = await sendWhatsAppTemplate(
      {
        name: ctx.plan.templateName,
        languageCode: ctx.plan.languageCode,
        bodyParams: [...ctx.plan.bodyParams],
      },
      { accessToken: accessToken!, phoneNumberId: phoneNumberId!, recipient: ctx.recipient! },
    );
    await db
      .from('notification_log')
      .update({ status: 'sent', provider_message_id: providerMessageId })
      .eq('id', claimed!.id);
  } catch (err) {
    outcome = 'failed';
    failureMessage = describeError(err);
    await db
      .from('notification_log')
      .update({ status: 'failed', error: failureMessage })
      .eq('id', claimed!.id);
  }

  // The event the issue asks for: who was resent, by which path, with what
  // outcome. Greppable as operator.welcome_resend, like the app's other
  // structured lines.
  console.log(
    JSON.stringify({
      event: 'operator.welcome_resend',
      companyId,
      audience,
      personId,
      status: outcome,
      ...(failureMessage ? { error: failureMessage } : {}),
    }),
  );

  back(outcome === 'sent' ? 'sent' : `failed:${encodeURIComponent(failureMessage!.slice(0, 200))}`);
}
