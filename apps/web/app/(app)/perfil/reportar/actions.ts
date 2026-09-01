'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { clampReportText } from '@/lib/problem-report';
import { logEvent } from '@/lib/log';

// The app half of "report a problem" (issue #120).
//
// The insert runs on the TENANT's own RLS client — never getDb(); the
// system-vs-user split forbids it on the request path. What makes that safe is
// declared in 0042, not here: the INSERT policy pins company_id to the
// caller's own company and profile_id to auth.uid(), and the column-scoped
// grant withholds worker_id and channel entirely, so even a forged request
// can only ever file a report as this manager, in their own company, on the
// 'app' channel.
//
// ⚠ NO `.select()` on the insert. problem_reports is write-only for tenants —
// there is no SELECT policy or grant — and supabase-js only asks for the row
// back when you chain `.select()`, whose RETURNING clause needs SELECT. Chained,
// this insert would fail 42501 on a perfectly healthy database while the bare
// write succeeds (the ai_usage trap, AGENTS.md).
//
// Redirect-with-param + a flash strip, the same no-JS shape as the settings
// rooms: a cold PWA on a bad site connection can file a report before any
// JavaScript has run — which matters more here than anywhere, because "the app
// is broken" is exactly when the reporter's JavaScript may not be running.

export async function fileProblemReport(formData: FormData): Promise<void> {
  const { db, companyId, userId, locale } = await requireAuth();

  const text = clampReportText(String(formData.get('texto') ?? ''));
  if (!text) redirect('/perfil/reportar?erro=vazio');

  // Attached by US, never typed by them (#120): the screen, the language they
  // read in, and the browser — the things a person on a roof will not type and
  // the operator always wants.
  const requestHeaders = await headers();
  const context = {
    source: 'app',
    screen: '/perfil/reportar',
    locale,
    userAgent: requestHeaders.get('user-agent') ?? undefined,
  };

  const { error } = await db.from('problem_reports').insert({
    company_id: companyId,
    profile_id: userId,
    text,
    context,
  });

  if (error) {
    // The one failure this feature exists to end is a report quietly lost, so
    // the page says so instead of pretending. Greppable beside the WhatsApp
    // flow's events; the report text itself is never logged.
    logEvent('problem_report.file_failed', {
      companyId,
      audience: 'manager',
      via: 'app',
      error: error.message,
      code: error.code,
    });
    redirect('/perfil/reportar?erro=guardar');
  }

  logEvent('problem_report.filed', { companyId, audience: 'manager', channel: 'app', via: 'app' });
  redirect('/perfil/reportar?enviado=1');
}
