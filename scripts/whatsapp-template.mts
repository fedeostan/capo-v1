// Meta message templates — create, list, and check.
//
// Templates are the only way to reach someone outside Meta's 24-hour window,
// they are reviewed asynchronously, and an unapproved one fails every send with
// 132001 — a failure that lands as a `failed` row in notification_log and
// nowhere else. This script exists so submitting a template and answering "is
// it approved, in all three languages, with the copy we think it has?" are both
// things you can do from the repo.
//
// Needs a real WHATSAPP_ACCESS_TOKEN and network access, so — like agent-smoke
// and unlike whatsapp-check — this is a MANUAL gate. It is never run in CI.
//
//   pnpm whatsapp-template numbers  every phone number + its Phone number ID
//   pnpm whatsapp-template list     every template on the WABA, with status
//   pnpm whatsapp-template status   the ones we manage: PASS/FAIL + exit code
//   pnpm whatsapp-template create   submit scripts/whatsapp-templates.ts
//
// Exit 0 = green, 1 = something needs a human.
//
// The token needs the `whatsapp_business_management` scope. The System User
// token from docs/whatsapp-cloud-api-runbook.md §3 already has it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── env (must land in process.env before anything reads it) ────────────────
// Same loader as agent-smoke.mts / knowledge-ingest.mts. The `!(m[1] in
// process.env)` is load-bearing here in a way it is not there: the WhatsApp
// secrets live in Vercel, not in .env.local, so the supported way to run this
// is to export them for one command —
//
//   vercel env pull /tmp/vercel.env --environment=production
//   set -a; . /tmp/vercel.env; set +a; pnpm whatsapp-template status
//
// — and real env winning is what makes that work. Never `vercel env pull` over
// apps/web/.env.local itself: it rewrites the file wholesale and that file
// holds local-only keys (GOOGLE_GENERATIVE_AI_API_KEY, TWILIO_*, …) that are
// not in Vercel and would be silently lost.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(repoRoot, 'apps/web/.env.local');
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // Absent .env.local is fine — the exported-env path above is the normal one.
}

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing WHATSAPP_ACCESS_TOKEN.');
  console.error('It lives in Vercel, not apps/web/.env.local. Export it for one command:');
  console.error('  vercel env pull /tmp/vercel.env --environment=production');
  console.error('  set -a; . /tmp/vercel.env; set +a; pnpm whatsapp-template status');
  process.exit(1);
}

const { allTemplates, MANAGED_TEMPLATE_NAMES, TEMPLATE_LANGUAGES } = await import(
  './whatsapp-templates.ts'
);

// The same literal as packages/core/src/channels/whatsapp.ts:303. Duplicated
// rather than imported, deliberately: a management script must not be able to
// pin or drift the version the message SENDER uses.
const GRAPH = 'https://graph.facebook.com/v23.0';

/** Redact the token from anything we print. It appears in query strings. */
const scrub = (s: string) => s.split(TOKEN!).join('<token>');

/**
 * Meta's error body IS the diagnosis — the `code`/`error_subcode` pair is the
 * only thing that distinguishes "already exists" from "rejected copy" from
 * "your token lost the scope". Print it verbatim, always, and never
 * paraphrase it into something that looks handled.
 */
async function graph(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`\n${init?.method ?? 'GET'} ${scrub(url)} → ${res.status}`);
    console.error(scrub(body));
    throw new Error(`Graph API ${res.status}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * Find the WABA id from the token itself.
 *
 * A System User token is scoped to the assets it was granted, and
 * `whatsapp_business_management.target_ids` in the debug_token response IS that
 * grant. So the token already knows the answer, and nobody has to copy an id
 * out of a dashboard into a second env var that then goes stale. The runbook
 * currently just says "note it down" (§1 step 3) and the id appears nowhere in
 * the repo — this is why.
 *
 * WHATSAPP_WABA_ID overrides, for the case where one token covers several.
 */
async function discoverWabaId(): Promise<string> {
  if (process.env.WHATSAPP_WABA_ID) return process.env.WHATSAPP_WABA_ID;
  const json = await graph(`${GRAPH}/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`);
  const data = json.data as { granular_scopes?: { scope: string; target_ids?: string[] }[] } | undefined;
  const ids = data?.granular_scopes?.find(s => s.scope === 'whatsapp_business_management')?.target_ids ?? [];
  if (ids.length === 0) {
    throw new Error(
      'This token carries no whatsapp_business_management target. Re-grant the System User ' +
        'the WhatsApp Business Account asset (runbook §3), or set WHATSAPP_WABA_ID.',
    );
  }
  if (ids.length > 1) {
    throw new Error(`Token covers ${ids.length} WABAs (${ids.join(', ')}) — set WHATSAPP_WABA_ID.`);
  }
  return ids[0];
}

interface LiveTemplate {
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: { type: string; text?: string; buttons?: { type: string; text: string }[] }[];
}

/** Every template on the WABA, following Meta's cursor pagination to the end. */
async function listLive(waba: string): Promise<LiveTemplate[]> {
  const out: LiveTemplate[] = [];
  let url = `${GRAPH}/${waba}/message_templates?fields=name,language,status,category,components&limit=100`;
  for (;;) {
    const page = (await graph(url)) as { data?: LiveTemplate[]; paging?: { next?: string } };
    out.push(...(page.data ?? []));
    if (!page.paging?.next) return out;
    url = page.paging.next;
  }
}

const buttonTextsOf = (components: { type: string; buttons?: { text: string }[] }[] | undefined) =>
  components?.find(c => c.type.toUpperCase() === 'BUTTONS')?.buttons?.map(b => b.text) ?? [];

const bodyTextOf = (components: { type: string; text?: string }[] | undefined) =>
  components?.find(c => c.type.toUpperCase() === 'BODY')?.text ?? '';

const command = process.argv[2] ?? 'status';
const waba = await discoverWabaId();
console.log(
  `WABA ${waba} (${process.env.WHATSAPP_WABA_ID ? 'from WHATSAPP_WABA_ID' : 'discovered from token'})\n`,
);

// `numbers` answers the one question the Meta dashboard is worst at: what is
// the Phone number ID for this number? It is the only per-number env var
// (WHATSAPP_PHONE_NUMBER_ID) and it is NOT the phone number — it is an opaque
// ~15-digit id sitting next to a WhatsApp Business Account ID of identical
// shape, which is exactly the pair you do not want to confuse at 9pm.
//
// The dashboard has moved it twice (it was "API Setup", it is now "Step 1: Try
// it out" inside the Quickstart flow, and the labels are localized on top of
// that), so this asks the WABA instead. Same discovery path as everything else
// here: the token knows which account it is for.
if (command === 'numbers') {
  const page = (await graph(
    `${GRAPH}/${waba}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`,
  )) as {
    data?: {
      id: string;
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      code_verification_status?: string;
    }[];
  };
  const numbers = page.data ?? [];
  if (numbers.length === 0) console.log('(no phone numbers on this WABA)');
  for (const n of numbers) {
    console.log(`\n${n.display_phone_number ?? '(no number)'}   ${n.verified_name ?? ''}`);
    console.log(`  WHATSAPP_PHONE_NUMBER_ID = ${n.id}`);
    console.log(`  quality=${n.quality_rating ?? '?'}  verification=${n.code_verification_status ?? '?'}`);
  }
  console.log(`\nSet the id above as WHATSAPP_PHONE_NUMBER_ID in Vercel (Production + Preview), then redeploy.`);
  console.log(`It is NOT the WABA id (${waba}) — that one is discovered from the token and needs no env var.`);
  process.exit(0);
}

if (command === 'list') {
  const live = await listLive(waba);
  if (live.length === 0) console.log('(no templates on this WABA)');
  for (const t of live.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language))) {
    console.log(`${t.status.padEnd(10)} ${t.name.padEnd(24)} ${t.language.padEnd(6)} ${t.category ?? ''}`);
  }
  process.exit(0);
}

if (command === 'create') {
  let failed = 0;
  for (const def of allTemplates()) {
    try {
      const res = await graph(`${GRAPH}/${waba}/message_templates`, {
        method: 'POST',
        body: JSON.stringify(def),
      });
      console.log(`SUBMITTED  ${def.name} ${def.language} → id=${res.id} status=${res.status}`);
    } catch {
      // The body is already printed verbatim above. Meta's 2388023 means this
      // name+language pair already exists, which makes re-running `create`
      // idempotent rather than broken — worth knowing before you go hunting.
      failed += 1;
    }
  }
  console.log('\nReview usually takes minutes (Meta allows up to 24h).');
  console.log('Run `pnpm whatsapp-template status` until every line is PASS.');
  process.exit(failed === 0 ? 0 : 1);
}

if (command !== 'status') {
  console.error(`Unknown command '${command}'. Use: numbers | list | status | create`);
  process.exit(1);
}

// ── status: the go-live gate ────────────────────────────────────────────────
// Two questions, because they fail independently:
//   1. Does every managed template exist and is it APPROVED, in all three
//      languages? An un-approved language is invisible until a worker on that
//      locale gets nothing and a 132001 lands in notification_log.
//   2. For the templates we hold a definition for, does the LIVE button text
//      still match @capo/i18n? This is the one that catches a label reworded in
//      the catalog months after approval: tsc stays green, whatsapp-check stays
//      green, and the worker keeps seeing the old words, because the labels are
//      baked into the approved template and never sent at runtime.
const live = await listLive(waba);
let failures = 0;
const say = (ok: boolean, line: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
};

// WARN, not FAIL, and deliberately so. Body drift is real information — the
// repo definition is not authoritative for a name+language Meta already
// approved, and capo_daily_briefing pt_PT was hand-made long before this file
// existed. But an approved template still delivers correctly while its wording
// differs from ours, so this must not block a go-live gate. The fix is to edit
// the live template in WhatsApp Manager: Meta has no API to rewrite an approved
// pair, and `create` answers 2388023 for one that exists.
let warnings = 0;
const warn = (ok: boolean, line: string) => {
  if (!ok) warnings += 1;
  console.log(`${ok ? 'PASS' : 'WARN'}  ${line}`);
};

for (const name of MANAGED_TEMPLATE_NAMES) {
  for (const language of TEMPLATE_LANGUAGES) {
    const found = live.find(t => t.name === name && t.language === language);
    say(found?.status === 'APPROVED', `${name} ${language} — ${found?.status ?? 'MISSING'}`);
  }
}

for (const def of allTemplates()) {
  const found = live.find(t => t.name === def.name && t.language === def.language);
  if (!found) continue; // already reported as MISSING above
  const liveButtons = buttonTextsOf(found.components);
  const repoButtons = buttonTextsOf(def.components as { type: string; buttons?: { text: string }[] }[]);
  say(
    JSON.stringify(liveButtons) === JSON.stringify(repoButtons),
    `${def.name} ${def.language} buttons — live ${JSON.stringify(liveButtons)}, repo ${JSON.stringify(repoButtons)}`,
  );

  const liveBody = bodyTextOf(found.components);
  const repoBody = bodyTextOf(def.components as { type: string; text?: string }[]);
  warn(liveBody === repoBody, `${def.name} ${def.language} body\n        live: ${liveBody}\n        repo: ${repoBody}`);
}

console.log(`\nTemplate status: ${failures === 0 ? 'all green' : `${failures} failure(s)`}`);
if (warnings > 0) console.log(`${warnings} body-text warning(s) — see WARN lines above; these do not block.`);
process.exit(failures === 0 ? 0 : 1);
