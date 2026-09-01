import type { Metadata } from 'next';
import { Field, Textarea } from '@capo/ui/field';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { REPORT_TEXT_MAX } from '@/lib/problem-report';
import { RoomShell } from '../room-shell';
import { Card, SubmitButton } from '../settings-controls';
import { fileProblemReport } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.report.row.title) };
}

// "Report a problem" (issue #120): one textarea, one button, nothing else
// required. The report carries its own context — screen, language, browser —
// attached by the server action, so the person writes one sentence and we
// attach the rest.
//
// A plain <form action> with a redirect-param flash, like every settings room:
// it must keep working with no JavaScript, because "the app is broken" is the
// one screen most likely to be visited while the app is broken.
//
// What this page deliberately does NOT say: who else can read it (nobody in
// the company — reports go to the operator only), or that anyone will reply
// (triage is out of scope, #120). The intro line frames it as going to the
// Capo team, which is the whole truth.
export default async function ReportarPage({
  searchParams,
}: {
  searchParams: Promise<{ enviado?: string; erro?: string }>;
}) {
  const { locale, t } = await requireAuthT();
  const { enviado, erro } = await searchParams;

  return (
    <RoomShell title={t.report.row.title} backLabel={t.profile.title} locale={locale}>
      {enviado && (
        <p className="rounded-lg bg-success-quiet px-3 py-2 text-center text-callout text-success">
          {t.report.sent}
        </p>
      )}
      {erro && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {erro === 'vazio' ? t.report.empty : t.report.failed}
        </p>
      )}

      <Card title={t.report.row.title}>
        <p className="text-callout text-fg-muted">{t.report.intro}</p>
        <form action={fileProblemReport} className="space-y-3">
          <Field id="report-texto" label={t.report.label} required>
            {a11y => (
              <Textarea
                {...a11y}
                name="texto"
                rows={5}
                maxLength={REPORT_TEXT_MAX}
                placeholder={t.report.placeholder}
                required
              />
            )}
          </Field>
          <SubmitButton label={t.report.submit} />
        </form>
      </Card>
    </RoomShell>
  );
}
