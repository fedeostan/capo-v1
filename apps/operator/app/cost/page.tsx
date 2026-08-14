import { formatUsd } from '@capo/core/agent/pricing';
import { loadCostReport, totalTokens, type CompanyCost, type PersonSpend } from '../data';

// Reads the DB (service role, lazy env) per request — must never be
// prerendered at build time, when those secrets don't exist.
export const dynamic = 'force-dynamic';

// The cost screen (issue #53). Cross-tenant by design, which is exactly why it
// lives here and not in the tenant app: comparing what one company costs
// against another is an operator question, and putting it behind the operator
// deploy means it needs no new tenant read surface at all.
//
// Two ledgers, one page, and the page is careful to keep them apart:
//   - AI tokens (ai_usage, 0032) — priced at read time from
//     packages/core/src/agent/pricing.ts. Never stored as money.
//   - WhatsApp template sends (notification_log, 0016) — read on the service
//     role, which bypasses RLS legitimately and adds no policy.
//
// A third cost is deliberately NOT here: Vercel hosting. See the footer.

const WINDOW_DAYS = 30;

// ai_usage.surface is snake_case wire vocabulary shared with the migration's
// CHECK constraint and with packages/core/src/agent/usage.ts. Label it here
// rather than teaching the reader to translate.
const SURFACE_LABEL: Record<string, string> = {
  manager_chat: 'Manager chat',
  worker_chat: 'Worker chat',
  summarizer: 'Conversation summary',
  planner: 'Plan generation',
  translation: 'Data translation',
  transcription: 'Voice notes',
  vocab_extraction: 'Vocabulary learning',
};

const KIND_LABEL: Record<PersonSpend['kind'], string> = {
  manager: 'Manager',
  worker: 'Worker',
  system: 'Company-wide',
};

function n(value: number): string {
  return value.toLocaleString('en-GB');
}

/** Share of prompt tokens served from cache — the #58 saving, made visible. */
function cacheHitRate(company: CompanyCost): number | null {
  const prompt =
    company.tokens.input_tokens + company.tokens.cache_read_tokens + company.tokens.cache_write_tokens;
  if (prompt === 0) return null;
  return company.tokens.cache_read_tokens / prompt;
}

export default async function CostPage() {
  const report = await loadCostReport(WINDOW_DAYS);
  const grandTotal = report.totalAiUsd + report.totalWhatsappUsd;
  const cacheSaving = report.totalAiUsdUncached - report.totalAiUsd;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-lg font-semibold">Cost</h1>
        <p className="text-xs text-zinc-500">
          Last {report.windowDays} days ({report.fromDate} → {report.toDate}, Europe/Lisbon). Everything
          in US dollars, because that is what Anthropic, Google and Meta bill in — no exchange rate is
          applied anywhere.
        </p>

        {report.ledgerMissing && (
          <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            The <code>ai_usage</code> table does not exist yet — migration <code>0032</code> has not been
            applied. Token figures below are empty for that reason, not because nothing was spent. The
            WhatsApp column is unaffected.
          </p>
        )}

        {report.ledgerError && (
          <p className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm">
            The usage ledger could not be read: <code>{report.ledgerError}</code>. The table exists — this
            is not a missing migration. Token figures below are empty for that reason, not because
            nothing was spent.
          </p>
        )}

        {report.truncated && (
          <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            The usage ledger was read up to its page ceiling, so every figure on this page is a{' '}
            <strong>floor</strong>, not a total. Narrow the window or move this aggregation into SQL.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={formatUsd(grandTotal)} sub={`${report.windowDays} days`} />
          <Stat
            label="AI tokens"
            value={formatUsd(report.totalAiUsd)}
            sub={`${n(report.totalRequests)} model requests`}
          />
          <Stat
            label="WhatsApp"
            value={formatUsd(report.totalWhatsappUsd)}
            sub={`${n(report.totalWhatsappSends)} template sends`}
          />
          <Stat
            label="Saved by caching"
            value={formatUsd(cacheSaving)}
            sub={cacheSaving >= 0 ? 'vs. caching off' : 'CACHING IS COSTING MORE'}
          />
        </div>

        {report.totalUnpricedRequests > 0 && (
          <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            {n(report.totalUnpricedRequests)} model request
            {report.totalUnpricedRequests === 1 ? '' : 's'} used a model with no line in the rate card, so{' '}
            <strong>their cost is missing from every figure above</strong> — counted as zero, which is not
            the same as free. Add the model id to <code>packages/core/src/agent/pricing.ts</code>.
          </p>
        )}
      </section>

      {report.companies.length === 0 && (
        <p className="text-sm text-zinc-500">Nothing recorded in this window.</p>
      )}

      <div className="space-y-4">
        {report.companies.map(company => {
          const hit = cacheHitRate(company);
          return (
            <section key={company.companyId} className="rounded-lg border border-zinc-500/20 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">{company.companyName}</h2>
                <span className="text-sm">
                  {formatUsd(company.aiUsd + company.whatsappUsd)}
                  <span className="ml-2 text-xs text-zinc-500">
                    {formatUsd(company.aiUsd)} AI · {formatUsd(company.whatsappUsd)} WhatsApp
                  </span>
                </span>
              </div>

              <p className="mt-1 text-xs text-zinc-500">
                {n(company.requests)} model request{company.requests === 1 ? '' : 's'} ·{' '}
                {n(totalTokens(company.tokens))} tokens ·{' '}
                {n(company.whatsappSends)} paid WhatsApp send{company.whatsappSends === 1 ? '' : 's'}
                {hit != null && <> · {(hit * 100).toFixed(0)}% of prompt tokens served from cache</>}
              </p>

              {/* The four buckets, spelled out. They are DISJOINT (0032): total
                  prompt tokens = input + cache read + cache write. Showing them
                  separately is the only way the prompt-caching work of #58 is
                  measurable at all. */}
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                <span>input {n(company.tokens.input_tokens)}</span>
                <span>cache read {n(company.tokens.cache_read_tokens)}</span>
                <span>cache write {n(company.tokens.cache_write_tokens)}</span>
                <span>output {n(company.tokens.output_tokens)}</span>
              </p>

              {company.people.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <h3 className="mb-1 text-xs font-medium text-zinc-500">Per person</h3>
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                        <th className="py-2 pr-4 font-normal">Who</th>
                        <th className="py-2 pr-4 font-normal">Role</th>
                        <th className="py-2 pr-4 font-normal">Requests</th>
                        <th className="py-2 pr-4 font-normal">Tokens</th>
                        <th className="py-2 pr-4 font-normal">AI</th>
                        <th className="py-2 pr-4 font-normal">WhatsApp</th>
                        <th className="py-2 font-normal">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-500/10">
                      {company.people.map(person => (
                        <tr key={person.key}>
                          <td className="py-2 pr-4">{person.name}</td>
                          <td className="py-2 pr-4 text-xs text-zinc-500">{KIND_LABEL[person.kind]}</td>
                          <td className="py-2 pr-4">{n(person.requests)}</td>
                          <td className="py-2 pr-4">{n(totalTokens(person.tokens))}</td>
                          <td className="py-2 pr-4">{formatUsd(person.aiUsd)}</td>
                          <td className="py-2 pr-4">
                            {person.whatsappSends > 0 ? (
                              <>
                                {formatUsd(person.whatsappUsd)}
                                <span className="ml-1 text-xs text-zinc-500">({n(person.whatsappSends)})</span>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2">{formatUsd(person.aiUsd + person.whatsappUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {company.surfaces.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <h3 className="mb-1 text-xs font-medium text-zinc-500">Per part of the product</h3>
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-500/20 text-xs text-zinc-500">
                        <th className="py-2 pr-4 font-normal">Surface</th>
                        <th className="py-2 pr-4 font-normal">Requests</th>
                        <th className="py-2 pr-4 font-normal">Tokens</th>
                        <th className="py-2 font-normal">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-500/10">
                      {company.surfaces.map(surface => (
                        <tr key={surface.surface}>
                          <td className="py-2 pr-4">{SURFACE_LABEL[surface.surface] ?? surface.surface}</td>
                          <td className="py-2 pr-4">{n(surface.requests)}</td>
                          <td className="py-2 pr-4">{n(totalTokens(surface.tokens))}</td>
                          <td className="py-2">{formatUsd(surface.aiUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <section className="space-y-2 border-t border-zinc-500/20 pt-4 text-xs text-zinc-500">
        <h2 className="font-medium text-zinc-500">What these numbers are, and are not</h2>
        <p>
          <strong>Vercel hosting is not on this page and cannot be.</strong> It is one flat platform bill
          for the whole product — one set of functions, one bandwidth pool, one cron scheduler serving
          every company at once — and nothing meters it per tenant. Any per-company hosting figure would
          be invented. Read it off the Vercel dashboard as a single overhead line.
        </p>
        <p>
          <strong>Token cost is attributed to whoever spoke, never to whoever was discussed.</strong> A
          manager&apos;s chat turn is a manager cost even when the whole conversation is about one crew
          member, because there is no honest way to split it. Per-worker WhatsApp cost is different: the
          send log records exactly who each paid template went to, so that column really is per person.
        </p>
        <p>
          <strong>Anthropic rates are published; the Gemini and WhatsApp rates are estimates.</strong>{' '}
          Voice-note transcription and every WhatsApp figure on this page are priced from working numbers
          that have not been checked against a bill. Verify them in the provider consoles before quoting
          any of it. Prices live in <code>packages/core/src/agent/pricing.ts</code>; the ledger stores
          tokens only, so re-pricing the whole history is one edit there.
        </p>
        <p>
          <strong>Free-form WhatsApp replies cost nothing and are not counted.</strong> Only approved
          templates are billed, and only those are logged.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-zinc-500/20 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      <div className="text-xs text-zinc-500">{sub}</div>
    </div>
  );
}
