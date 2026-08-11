// WhatsApp channel check — the deterministic half of the WhatsApp QA gate.
// Like `pnpm scheduler-check` (and unlike `pnpm agent-smoke`) it needs NO
// credentials, no network and no model, so it can run in CI on every PR.
//
// It guards the bugs this file was written for:
//   1. Approval cards never reached WhatsApp at all — the sink filtered the
//      assistant's parts down to `type === 'text'`, and a card is a TOOL
//      output part. The manager was told a card had appeared and got nothing.
//   2. The model writes markdown (`**bold**`); WhatsApp bold is a SINGLE
//      asterisk, so every emphasis rendered as literal asterisks.
//   3. Meta rejects an interactive message whose button title exceeds 20 chars
//      or whose body exceeds 1024 — a runtime 400 with no build-time signal.
//   4. A template quick-reply payload has far less room than an interactive
//      reply id's 256 chars, and a truncated payload does not fail loudly — it
//      comes back unparseable and the worker's tap disappears.
//   5. A template body parameter containing a newline, a tab or a run of 4+
//      spaces is rejected wholesale with Meta's 132000, and the natural way to
//      render a task list is one per line.
//
// Run with `pnpm whatsapp-check`. Exit 0 = green, 1 = at least one failure.

import type { UIMessage } from 'ai';
import {
  buildTemplatePayload,
  checkinPayload,
  hasWhatsAppConsent,
  parseCheckinPayload,
  parseProposalButtonId,
  planAssistantMessages,
  proposalButtonId,
  splitForWhatsApp,
  toTemplateParam,
  toWhatsAppMarkdown,
  type ApprovalLabels,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES } from '@capo/i18n/locale';
import { allTemplates, MANAGED_TEMPLATE_NAMES, TEMPLATE_LANGUAGES } from './whatsapp-templates.ts';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── markdown conversion ─────────────────────────────────────────────────────
const md: [name: string, input: string, expected: string][] = [
  ['bold loses the doubled asterisk', '**Casa de Paco**', '*Casa de Paco*'],
  ['two bold spans on one line', '**a** e **b**', '*a* e *b*'],
  ['bold-italic becomes nested markers', '***a***', '*_a_*'],
  ['underscore bold-italic', '___a___', '*_a_*'],
  ['underscore bold', '__a__', '*a*'],
  ['single underscores are left alone', '_a_', '_a_'],
  ['snake_case survives (documented non-goal)', 'campo start_date', 'campo start_date'],
  ['h1 becomes bold', '# Plano', '*Plano*'],
  ['heading with inner bold stays balanced', '### **Prazo**', '*Prazo*'],
  ['links are flattened', '[Capo](https://capo.pt)', 'Capo (https://capo.pt)'],
  ['a self-titled link keeps only the url', '[https://x.pt](https://x.pt)', 'https://x.pt'],
  ['images keep their alt text', '![obra](https://x.pt/a.png)', 'obra (https://x.pt/a.png)'],
  ['asterisk bullets become dashes', '* uma\n* duas', '- uma\n- duas'],
  ['plus bullets become dashes', '+ uma', '- uma'],
  ['dash bullets are already native', '- uma\n- duas', '- uma\n- duas'],
  ['numbered lists are already native', '1. uma\n2. duas', '1. uma\n2. duas'],
  ['block quotes are already native', '> atenção', '> atenção'],
  ['horizontal rules are dropped', 'a\n\n---\n\nb', 'a\n\nb'],
  // The trap the [^\n] emphasis patterns exist to prevent: a greedy [\s\S]
  // pattern would pair the two line-leading asterisks into one bold span.
  ['a bullet list is never eaten as one bold span', '* a\n* b\n* c', '- a\n- b\n- c'],
  ['a fenced block is byte-identical', 'x\n\n```\n**nao** _tocar_\n```', 'x\n\n```\n**nao** _tocar_\n```'],
  ['inline code is byte-identical', 'usa `**isto**` assim', 'usa `**isto**` assim'],
];

for (const [name, input, expected] of md) {
  eq(name, toWhatsAppMarkdown(input), expected);
}

// Idempotence: the sink must be safe to run over already-converted text.
check(
  'conversion is idempotent over every fixture',
  md.every(([, input]) => toWhatsAppMarkdown(toWhatsAppMarkdown(input)) === toWhatsAppMarkdown(input)),
  md.filter(([, i]) => toWhatsAppMarkdown(toWhatsAppMarkdown(i)) !== toWhatsAppMarkdown(i))
    .map(([n]) => n)
    .join(', '),
);

// A realistic Capo paragraph, end to end.
eq(
  'a realistic reply converts whole',
  toWhatsAppMarkdown('Listo, jefe. Obra creada: **Casa de Paco**.\n\n* cocina\n* baño\n\nVer [el plan](https://capo.pt/p/1).'),
  'Listo, jefe. Obra creada: *Casa de Paco*.\n\n- cocina\n- baño\n\nVer el plan (https://capo.pt/p/1).',
);

// ── splitting ───────────────────────────────────────────────────────────────
const long = Array.from({ length: 300 }, (_, i) => `parágrafo ${i} ${'x'.repeat(30)}`).join('\n\n');
const chunks = splitForWhatsApp(long);
check('a 9k-char body is split', chunks.length > 1, `${long.length} chars → ${chunks.length} chunks`);
check(
  'every chunk fits WhatsApp\'s text limit',
  chunks.every(c => c.length <= 4000),
  chunks.map(c => c.length).join(', '),
);
check(
  'splitting loses no content',
  chunks.join('').replace(/\s/g, '') === long.replace(/\s/g, ''),
);
eq('a short body is a single chunk', splitForWhatsApp('curto').length, 1);

// ── button id codec ─────────────────────────────────────────────────────────
const uuid = '3f1a9c02-5b7d-4e88-9a10-2c6d4f8b1e33';
const approveId = proposalButtonId('approve', uuid);
eq('button ids round-trip (decision)', parseProposalButtonId(approveId)?.decision, 'approve');
eq('button ids round-trip (proposal)', parseProposalButtonId(approveId)?.proposalId, uuid);
check('a minted id fits Meta\'s 256-char cap', approveId.length <= 256, `${approveId.length} chars`);
// A malformed uuid must be rejected HERE: it would otherwise reach a .eq() on
// a uuid column and surface as a Postgres 22P02 instead of "not ours".
eq('a malformed uuid is rejected', parseProposalButtonId('capo:approve:not-a-uuid'), null);
eq('a foreign prefix is rejected', parseProposalButtonId(`evil:approve:${uuid}`), null);
eq('an unknown decision is rejected', parseProposalButtonId(`capo:delete:${uuid}`), null);
eq('an empty id is rejected', parseProposalButtonId(''), null);
eq(
  'approve and reject ids differ',
  proposalButtonId('approve', uuid) === proposalButtonId('reject', uuid),
  false,
);

// ── check-in payload codec ──────────────────────────────────────────────────
const doneP = checkinPayload('done', uuid);
const notDoneP = checkinPayload('not_done', uuid);
eq('check-in payloads round-trip (answer)', parseCheckinPayload(doneP)?.answer, 'done');
eq('check-in payloads round-trip (notification)', parseCheckinPayload(doneP)?.notificationId, uuid);
eq('the not_done answer round-trips too', parseCheckinPayload(notDoneP)?.answer, 'not_done');
// 128 is the cap sendWhatsAppTemplate THROWS on. If a minted payload ever
// exceeded it, every check-in send would fail at once — assert it can't.
check('a minted payload fits the 128-char cap', doneP.length <= 128, `${doneP.length} chars`);
check('the longer answer also fits', notDoneP.length <= 128, `${notDoneP.length} chars`);
eq('a malformed uuid is rejected', parseCheckinPayload('capo:checkin:done:not-a-uuid'), null);
eq('an unknown answer is rejected', parseCheckinPayload(`capo:checkin:maybe:${uuid}`), null);
eq('a foreign prefix is rejected', parseCheckinPayload(`evil:checkin:done:${uuid}`), null);
eq('an empty payload is rejected', parseCheckinPayload(''), null);
// THE failure mode this codec exists to make visible: if the template declares
// quick replies but the send omits the button component, Meta returns 200 and
// echoes the button's LABEL as the payload. It must parse as null, not as an
// answer.
eq('a bare button label is rejected', parseCheckinPayload('Sim, terminei'), null);
eq('done and not_done payloads differ', doneP === notDoneP, false);
// Cross-parse isolation. Two different button shapes arrive on the same
// webhook; neither parser may ever accept the other's value, or a manager's
// approval could be recorded as a worker's check-in.
eq('a proposal id is not a check-in payload', parseCheckinPayload(approveId), null);
eq('a check-in payload is not a proposal id', parseProposalButtonId(doneP), null);

// ── template parameters ─────────────────────────────────────────────────────
// toTemplateParam is the single easiest way to earn a 132000 and was asserted
// nowhere before.
eq('a newline is flattened', toTemplateParam('a\nb'), 'a b');
eq('a tab is flattened', toTemplateParam('a\tb'), 'a b');
eq('a run of spaces collapses', toTemplateParam('a    b'), 'a b');
eq('surrounding whitespace is trimmed', toTemplateParam('  a  '), 'a');
eq('already-flat text is untouched', toTemplateParam('Pintar paredes (Casa de Paco)'), 'Pintar paredes (Casa de Paco)');
eq("the briefing's own separator survives", toTemplateParam('a · b'), 'a · b');
const longParam = toTemplateParam('x'.repeat(2000));
eq('an over-long parameter is cut to 900', longParam.length, 900);
check('and is marked as truncated', longParam.endsWith('…'), JSON.stringify(longParam.slice(-3)));

// ── template payload shape ──────────────────────────────────────────────────
// The backward-compatibility guard: capo_daily_briefing passes no quickReplies
// and must produce exactly what it always did.
const plain = buildTemplatePayload({ name: 'capo_daily_briefing', languageCode: 'pt_PT', bodyParams: ['Miguel', 'Hoje: nada'] });
const plainComponents = (plain.template as { components: Record<string, unknown>[] }).components;
eq('a button-less template sends one component', plainComponents.length, 1);
eq('and it is the body', plainComponents[0].type, 'body');

const withButtons = buildTemplatePayload({
  name: 'capo_task_checkin',
  languageCode: 'pt_PT',
  bodyParams: ['Miguel', 'Pintar paredes'],
  quickReplies: [{ payload: doneP }, { payload: notDoneP }],
});
const btnComponents = (withButtons.template as { components: Record<string, unknown>[] }).components;
eq('two quick replies add two components', btnComponents.length, 3);
eq('the button component type', btnComponents[1].type, 'button');
eq('the button sub_type', btnComponents[1].sub_type, 'quick_reply');
// A STRING index. Meta accepts a number in some versions and rejects it in
// others, so the type is pinned, not just the value.
eq('the first index is the string "0"', btnComponents[1].index, '0');
eq('and it really is a string', typeof btnComponents[1].index, 'string');
eq('the second index is "1"', btnComponents[2].index, '1');
const firstParam = (btnComponents[1].parameters as { type: string; payload: string }[])[0];
eq('the parameter type is payload', firstParam.type, 'payload');
// The ORDER CONTRACT: index 0 must carry 'done'. Swapping these inverts every
// answer and Meta still returns 200, so nothing else would ever catch it.
eq('index 0 carries the done payload', firstParam.payload, doneP);
eq(
  'index 1 carries the not_done payload',
  (btnComponents[2].parameters as { payload: string }[])[0].payload,
  notDoneP,
);
let threw = false;
try {
  buildTemplatePayload({ name: 'x', languageCode: 'pt_PT', bodyParams: [], quickReplies: [{ payload: 'y'.repeat(200) }] });
} catch {
  threw = true;
}
check('an over-long payload throws rather than truncating', threw);

// ── proactive-send consent ──────────────────────────────────────────────────
// The gate on every proactive send. It has no test suite behind it and one
// wrong branch messages someone who never agreed, so the truth table is pinned
// here — this is the closest thing the repo has to a policy assertion.
const T1 = '2026-08-01T09:00:00.000Z'; // earlier
const T2 = '2026-08-09T09:00:00.000Z'; // later
check('no record at all → no consent', !hasWhatsAppConsent({}));
check('nulls → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: null, whatsapp_opt_out_at: null }));
check('opted in, never out → consent', hasWhatsAppConsent({ whatsapp_opt_in_at: T1 }));
check('opted out after opting in → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: T1, whatsapp_opt_out_at: T2 }));
// The case a presence-only test would get wrong, leaving anyone who ever left
// permanently unreachable even after they asked to come back.
check('opted back in after opting out → consent', hasWhatsAppConsent({ whatsapp_opt_in_at: T2, whatsapp_opt_out_at: T1 }));
check('opted out with no opt-in → no consent', !hasWhatsAppConsent({ whatsapp_opt_out_at: T1 }));
// Same instant is a tie, and a tie must not be read as consent.
check('a simultaneous pair → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: T1, whatsapp_opt_out_at: T1 }));
// Garbage in a timestamp column must fail CLOSED, never open.
check('an unparseable opt-out → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: T1, whatsapp_opt_out_at: 'não sei' }));
check('an unparseable opt-in → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: 'ontem' }));

// ── committed template definitions ──────────────────────────────────────────
// These are the mistakes that would otherwise surface as a Meta rejection days
// later, or as an approved template that silently means the wrong thing.
const defs = allTemplates();

// Every managed name must be defined in every locale. This is the assertion
// that would have caught capo_daily_briefing's missing es_ES and en_US before
// they became a daily 132001 in notification_log — the template existed, just
// not in the language the recipient was on, and nothing in CI could see that
// while the definition lived only in WhatsApp Manager.
eq('a definition per managed template per locale', defs.length, MANAGED_TEMPLATE_NAMES.length * LOCALES.length);
for (const name of MANAGED_TEMPLATE_NAMES) {
  for (const language of TEMPLATE_LANGUAGES) {
    check(`${name} is defined in ${language}`, defs.some(d => d.name === name && d.language === language));
  }
}

for (const def of defs) {
  const locale = LOCALES.find(l => getCatalog(l).reminders.templateLanguage === def.language)!;
  const label = `${def.name} ${def.language}`;
  check(`${label} — language matches a real locale`, Boolean(locale));
  eq(`${label} — category`, def.category, 'UTILITY');
  eq(`${label} — parameter format`, def.parameter_format, 'POSITIONAL');

  const body = def.components.find(c => c.type === 'BODY') as { text: string; example: { body_text: string[][] } };
  const text = body.text;
  eq(`${label} — has {{1}} exactly once`, (text.match(/\{\{1\}\}/g) ?? []).length, 1);
  eq(`${label} — has {{2}} exactly once`, (text.match(/\{\{2\}\}/g) ?? []).length, 1);
  eq(`${label} — has no {{3}}`, text.includes('{{3}}'), false);
  // Meta rejects a body that starts or ends with a parameter.
  check(`${label} — does not start with a parameter`, !text.trimStart().startsWith('{{'), text.slice(0, 12));
  check(`${label} — does not end with a parameter`, !text.trimEnd().endsWith('}}'), text.slice(-12));
  // Sample count is validated against parameter count on submit.
  eq(`${label} — supplies two example values`, body.example.body_text[0]?.length, 2);

  // Buttons are asymmetric ON PURPOSE and the asymmetry is load-bearing.
  // capo_task_checkin is answered by tapping; capo_daily_briefing is answered
  // with free text (PT/ES/EN/STOP). Declaring a button component on a send
  // whose approved template has none earns a 132000 on every send, so a stray
  // BUTTONS block here would take the whole 07:00 briefing down.
  const buttonComponent = def.components.find(c => c.type === 'BUTTONS') as
    | { buttons: { type: string; text: string }[] }
    | undefined;
  if (def.name !== 'capo_task_checkin') {
    check(`${label} — declares no buttons`, buttonComponent === undefined);
    continue;
  }

  const buttons = buttonComponent!.buttons;
  eq(`${label} — exactly two buttons`, buttons.length, 2);
  check(`${label} — both are quick replies`, buttons.every(b => b.type === 'QUICK_REPLY'));
  // The labels must be the catalog's, in done-then-notDone order — the same
  // order /api/cron/checkin mints payloads in.
  const t = getCatalog(locale!).whatsapp;
  eq(`${label} — button 0 is the done label`, buttons[0].text, t.checkinDoneButton);
  eq(`${label} — button 1 is the not-done label`, buttons[1].text, t.checkinNotDoneButton);
  check(`${label} — labels differ`, buttons[0].text !== buttons[1].text);
  for (const b of buttons) {
    check(`${label} — "${b.text}" is 1..25 chars`, b.text.length >= 1 && b.text.length <= 25, `${b.text.length}`);
  }
}

// ── outbound planning ───────────────────────────────────────────────────────
const labels: ApprovalLabels = { approve: 'Aprobar', reject: 'Rechazar', prompt: '¿Apruebas, jefe?', fallback: 'Hazlo en la app.' };

function text(value: string): UIMessage['parts'][number] {
  return { type: 'text', text: value };
}

// Shaped exactly like what propose.ts / guard.ts / plan.ts return, wrapped in
// the AI SDK's tool part. `as` is needed because the SDK's part union is keyed
// on a template-literal tool name.
function card(renderedText: string, proposalId = uuid): UIMessage['parts'][number] {
  return {
    type: 'tool-propose',
    toolCallId: 'call-1',
    state: 'output-available',
    input: {},
    output: { status: 'proposed', proposalId, renderedText },
  } as unknown as UIMessage['parts'][number];
}

function toolOutput(output: unknown): UIMessage['parts'][number] {
  return {
    type: 'tool-list_tasks',
    toolCallId: 'call-2',
    state: 'output-available',
    input: {},
    output,
  } as unknown as UIMessage['parts'][number];
}

// THE regression guard for defect 1, and for "cards must not pile up at the
// end": a card has to land where it occurred in the turn.
const interleaved = planAssistantMessages([text('antes'), card('Crear tarea: «x».'), text('depois')], labels);
eq('a card is delivered, not dropped', interleaved.length, 3);
eq('prose before the card comes first', interleaved[0]?.kind, 'text');
eq('the card keeps its position', interleaved[1]?.kind, 'interactive');
eq('prose after the card comes last', interleaved[2]?.kind, 'text');
eq('trailing prose is not merged into the card', interleaved[2]?.body, 'depois');

// A short card IS the interactive body, byte-identical — rendered_text is the
// persisted approval artifact and must never be reworded or converted.
const short = planAssistantMessages([card('Crear tarea: «Pintar» en la obra Casa de Paco.')], labels);
eq('a short card is one interactive message', short.length, 1);
eq('a short card body is byte-identical', short[0]?.body, 'Crear tarea: «Pintar» en la obra Casa de Paco.');

// A markdown-looking card is still sent verbatim.
const literal = planAssistantMessages([card('Crear obra: «Casa **de** Paco».')], labels);
eq('card text is never markdown-converted', literal[0]?.body, 'Crear obra: «Casa **de** Paco».');

// Over 1024: the card goes as text, then a short interactive carries the
// buttons. Every real plan card takes this branch.
const big = planAssistantMessages([card('L'.repeat(2000))], labels);
eq('an over-limit card becomes text + interactive', big.length, 2);
eq('the card text is sent first', big[0]?.kind, 'text');
eq('the buttons follow in an interactive', big[1]?.kind, 'interactive');
eq('the interactive falls back to the prompt', big[1]?.body, labels.prompt);

const huge = planAssistantMessages([card('L'.repeat(6000))], labels);
eq('a 6k card splits across two texts + interactive', huge.length, 3);
eq('the last message carries the buttons', huge[2]?.kind, 'interactive');

// Meta's hard limits, asserted across every fixture.
const all = [...interleaved, ...short, ...literal, ...big, ...huge];
check(
  'every interactive body fits Meta\'s 1024 limit',
  all.every(m => m.kind !== 'interactive' || m.body.length <= 1024),
);
check('every text body fits the 4000-char split', all.every(m => m.kind !== 'text' || m.body.length <= 4000));
check(
  'every button title fits Meta\'s 20-char limit',
  all.every(m => m.kind !== 'interactive' || m.buttons.every(b => b.title.length <= 20)),
);
check(
  'the two button titles are distinct (Meta requires it)',
  all.every(m => m.kind !== 'interactive' || m.buttons[0]?.title !== m.buttons[1]?.title),
);
check(
  'every card offers exactly approve and reject',
  all.every(m => m.kind !== 'interactive' || m.buttons.length === 2),
);

// A long translation must degrade to a truncated label, never to a Meta 400.
const truncated = planAssistantMessages(
  [card('curto')],
  { approve: 'Aprovar esta proposta agora', reject: 'Rejeitar', prompt: 'p', fallback: 'f' },
);
eq('an over-long label is truncated, not passed through', truncated[0]?.kind === 'interactive'
  ? truncated[0].buttons[0]?.title.length
  : -1, 20);

// Parts that are not proposals must not produce buttons.
const noise = planAssistantMessages(
  [
    { type: 'step-start' } as UIMessage['parts'][number],
    { type: 'reasoning', text: 'pensando' } as UIMessage['parts'][number],
    toolOutput({ status: 'ok', rows: [] }),
    toolOutput({ status: 'error', message: 'boom' }),
    text('pronto'),
  ],
  labels,
);
eq('non-proposal parts yield only the prose', noise.length, 1);
eq('and no tool chips leak into WhatsApp', noise[0]?.body, 'pronto');

// The old sink returned early when there was no text, swallowing the card.
const silent = planAssistantMessages([card('Crear tarea: «x».')], labels);
eq('a card with no prose is still delivered', silent.length, 1);

// Prose is converted on the way out.
const converted = planAssistantMessages([text('Obra creada: **Casa de Paco**.')], labels);
eq('prose is markdown-converted', converted[0]?.body, 'Obra creada: *Casa de Paco*.');

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nWhatsApp check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
