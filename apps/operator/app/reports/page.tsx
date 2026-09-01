import { loadProblemReports } from '../data';

export const dynamic = 'force-dynamic';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' });
}

// Problem reports (issue #120) — the one place they are readable at all.
// Filed from the app's "Reportar um problema" form and from the WhatsApp
// keyword ("bug", "problema", …); tenants can write them and never read them.
//
// `text` is verbatim reporter prose from people we do not fully trust. It is
// rendered as data (React escapes it) and must never be pasted onward into
// anything that follows instructions — a GitHub issue body included, which is
// why promotion to an issue is a by-hand decision (#128).
//
// On the design tokens from the start, unlike its older siblings in
// design-check's UNCONVERTED ledger — that list may only ever shrink.
export default async function ReportsPage() {
  const { rows, error } = await loadProblemReports();

  return (
    <div className="space-y-6">
      <h1 className="text-heading font-semibold text-fg">Problem reports</h1>
      <p className="text-caption text-fg-muted">
        &ldquo;This is broken&rdquo;, from the app form and the WhatsApp keyword. Newest first, last{' '}
        {rows.length} shown. No status or triage by design — promote one to a GitHub issue by hand
        if it deserves it.
      </p>

      {error && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-callout text-danger">
          Could not read problem_reports: <code className="font-mono text-caption">{error}</code> —
          if this says the relation does not exist, migration 0042 has not been applied yet.
        </p>
      )}

      {!error && rows.length === 0 && (
        <p className="text-callout text-fg-muted">
          No reports yet. That is either good news or a broken report button.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-callout">
          <thead>
            <tr className="border-b border-hairline text-caption text-fg-muted">
              <th className="py-2 pr-4 font-normal">When</th>
              <th className="py-2 pr-4 font-normal">Company</th>
              <th className="py-2 pr-4 font-normal">Who</th>
              <th className="py-2 pr-4 font-normal">Channel</th>
              <th className="py-2 pr-4 font-normal">Report</th>
              <th className="py-2 font-normal">Context</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map(row => (
              <tr key={row.id} className="align-top">
                <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(row.created_at)}</td>
                <td className="py-2 pr-4">{row.companyName}</td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  {row.reporter}
                  <span className="ml-1 text-caption text-fg-muted">({row.audience})</span>
                </td>
                <td className="py-2 pr-4 text-caption">{row.channel}</td>
                <td className="max-w-md py-2 pr-4 break-words whitespace-pre-wrap">{row.text}</td>
                <td className="py-2 font-mono text-caption text-fg-muted">
                  {row.context ? JSON.stringify(row.context) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
