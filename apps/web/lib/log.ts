// Minimal structured logging: one JSON line per event, scraped by Vercel's
// log drain. No log aggregation service — see AGENTS.md observability decision.
export function logEvent(name: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ evt: name, ts: new Date().toISOString(), ...fields }));
}
