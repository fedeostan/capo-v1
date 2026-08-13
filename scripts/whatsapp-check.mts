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
//   6. Sender resolution must prefer the PHONE over the BSUID. Inverting that
//      preference would silently route every known manager through a second,
//      weaker key, and nothing else in this repo would notice.
//   7. A BSUID recipient goes in Meta's `recipient` field, never in `to`.
//      Sending both is legal and `to` wins — so the wrong shape does not fail,
//      it delivers to a stale phone number and reports success.
//   8. A `user_id_update` webhook change carries NO messages array, so the old
//      parser dropped every BSUID rotation without a trace. That is the one
//      defect here with no symptom at all: a stored id quietly stops pointing
//      at anybody, months after the change.
//   9. A worker turn can never produce an approval card — the worker roster has
//      no way to build one — so if one ever appears, the isolation between the
//      two rosters has broken. planWorkerMessages must THROW on that rather
//      than skip it: a dropped card is defect 1 again, and on the worker path
//      it would be the only signal we would ever get.
//  10. Every briefing went out as a PAID template, including to people already
//      inside their free 24-hour window (issue #46). The predicate that fixes
//      that has to fail CLOSED: guessing "inside" earns a 131047 and the
//      recipient gets NOTHING, which on the 07:00 send is a silent morning for
//      the whole crew. Guessing "outside" only costs money. Every ambiguity —
//      null, garbage, a future timestamp — must resolve to the template.
//
// Run with `pnpm whatsapp-check`. Exit 0 = green, 1 = at least one failure.

import type { UIMessage } from 'ai';
import {
  buildSendBody,
  buildTemplatePayload,
  checkinPayload,
  hasWhatsAppConsent,
  isBsuid,
  isOutsideWindowError,
  FREE_FORM_WINDOW_MS,
  OUTSIDE_WINDOW_ERROR_CODE,
  parseCheckinPayload,
  parseProposalButtonId,
  planAssistantMessages,
  planWorkerMessages,
  proposalButtonId,
  readSender,
  routeWebhookChanges,
  senderLabel,
  splitForWhatsApp,
  toTemplateParam,
  toWhatsAppMarkdown,
  WhatsAppSendError,
  withinFreeFormWindow,
  type ApprovalLabels,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES } from '@capo/i18n/locale';
import { allTemplates, MANAGED_TEMPLATE_NAMES, TEMPLATE_LANGUAGES } from './whatsapp-templates.ts';
// The free-form renderer lives in the web app rather than @capo/core, for the
// same reason renderWorkerBriefing does: it needs the USER copy catalog, which
// must never enter the agent bundle. Reached the same way scheduler-check
// reaches apps/web/lib/cron — it is pure, so no credentials come with it.
import {
  renderWorkerFreeForm,
  type BriefingTask,
  type WorkerBriefing,
} from '../apps/web/app/notifications/briefing.ts';

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

// ── bsuid ───────────────────────────────────────────────────────────────────
// isBsuid is the TS half of a rule enforced twice — the other half is the CHECK
// constraint in supabase/migrations/0022_whatsapp_bsuid.sql. Nothing keeps the
// two regexes in step automatically, so these assertions are also the record of
// what the constraint is supposed to say.
const bsuid = 'PT.13491208655302741918';
check('a real BSUID is accepted', isBsuid(bsuid));
check('a one-character tail is accepted', isBsuid('US.1'));
check('a 128-character tail is the limit', isBsuid(`US.${'x'.repeat(128)}`));
// THE rejection that matters. A parent BSUID is issued to a multi-portfolio
// business; Capo is a single portfolio, so one stored here would look like an
// identity while belonging to nobody in particular. The single dot is what
// refuses it — this is the assertion that catches a "helpful" regex loosening.
eq('a PARENT BSUID is rejected', isBsuid('US.ENT.11815799212886844830'), false);
eq('a phone number is not a BSUID', isBsuid('+351912345678'), false);
eq('a bare wa_id is not a BSUID', isBsuid('351912345678'), false);
eq('an empty string is rejected', isBsuid(''), false);
eq('a missing tail is rejected', isBsuid('PT.'), false);
eq('a missing dot is rejected', isBsuid('PT13491208655302741918'), false);
eq('a lowercase country code is rejected', isBsuid('pt.13491208655302741918'), false);
eq('a one-letter country code is rejected', isBsuid('P.123'), false);
eq('a 129-character tail is rejected', isBsuid(`US.${'x'.repeat(129)}`), false);
// Anchoring, both ends. An unanchored pattern would accept a BSUID with junk
// welded on and hand the DB something its CHECK constraint then rejects.
eq('a trailing newline is rejected', isBsuid(`${bsuid}\n`), false);
eq('a leading space is rejected', isBsuid(` ${bsuid}`), false);
eq('an embedded BSUID is rejected', isBsuid(`x${bsuid}x`), false);

// senderLabel runs inside after() callbacks, where a throw is an unhandled
// rejection that bypasses the very logEvent it was reaching for. All three
// shapes must produce a value, and none may leak a whole identifier.
eq('a phone sender is labelled by its last four', senderLabel({ from: '351912345678' }), '…5678');
eq('a BSUID-only sender is labelled and marked', senderLabel({ from_user_id: bsuid }), 'id:…1918');
eq('neither identifier is still a label', senderLabel({}), 'unknown');
eq('the phone wins when both are present', senderLabel({ from: '351912345678', from_user_id: bsuid }), '…5678');
check(
  'no label contains a whole identifier',
  [senderLabel({ from: '351912345678' }), senderLabel({ from_user_id: bsuid }), senderLabel({})].every(
    label => !label.includes('351912345678') && !label.includes(bsuid),
  ),
);
// The two shapes must be distinguishable in a log drain, or triage cannot tell
// "we do not know this number" from "this person has a username now".
check(
  'a phone label and a BSUID label are distinguishable',
  senderLabel({ from: '351911111918' }) !== senderLabel({ from_user_id: bsuid }),
);

// ── sender resolution: which identifier wins ────────────────────────────────
// THE safety property of the whole BSUID change. Phone-first is what guarantees
// today's payloads take today's path; if this preference ever inverted, every
// message from someone we know by phone would start being resolved against a
// second, weaker key, and nothing else in the repo would notice.
const waId = '351912345678';
eq('a phone-only sender is answered on the phone', readSender({ from: waId })?.replyTo.kind, 'phone');
eq('and carries no BSUID', readSender({ from: waId })?.bsuid, undefined);
eq(
  'a BSUID-only sender is answered on the BSUID',
  readSender({ from_user_id: bsuid })?.replyTo.kind,
  'bsuid',
);
eq('and has no phone to fall back to', readSender({ from_user_id: bsuid })?.from, undefined);
const bothIds = readSender({ from: waId, from_user_id: bsuid });
eq('WITH BOTH PRESENT, THE PHONE WINS', bothIds?.replyTo.kind, 'phone');
eq('and the reply goes to that exact wa_id', bothIds?.replyTo.kind === 'phone' ? bothIds.replyTo.waId : null, waId);
// Still carried, because captureBsuid needs it: the 30-day overlap in which
// both identifiers arrive together is the only chance to bind them.
eq('but the BSUID is still carried, for capture', bothIds?.bsuid, bsuid);
eq('neither identifier yields no sender at all', readSender({}), null);
// A parent BSUID must never become a lookup key — it belongs to a portfolio,
// not a person. isBsuid rejects it, and readSender is where that takes effect.
eq(
  'a parent BSUID alone is not a usable sender',
  readSender({ from_user_id: 'US.ENT.11815799212886844830' }),
  null,
);
eq(
  'and it never shadows a perfectly good phone',
  readSender({ from: waId, from_user_id: 'US.ENT.11815799212886844830' })?.bsuid,
  undefined,
);
eq('a malformed BSUID is treated as absent', readSender({ from_user_id: 'not-an-id' }), null);

// ── outbound addressing: `to` XOR `recipient` ───────────────────────────────
// Meta will not accept a BSUID in `to`, and if BOTH fields are sent it silently
// prefers `to`. That silent precedence is the failure this asserts against: a
// BSUID send that quietly went to a stale phone number looks like a success in
// every log we keep.
const message = { type: 'text', text: { body: 'olá' } };
const phoneBody = buildSendBody(message, { kind: 'phone', waId });
const bsuidBody = buildSendBody(message, { kind: 'bsuid', userId: bsuid });
eq('a phone recipient is addressed in `to`', phoneBody.to, waId);
eq('and emits no `recipient`', 'recipient' in phoneBody, false);
eq('a BSUID recipient is addressed in `recipient`', bsuidBody.recipient, bsuid);
eq('and emits no `to`', 'to' in bsuidBody, false);
check(
  'exactly one addressing field on every body',
  [phoneBody, bsuidBody].every(b => Number('to' in b) + Number('recipient' in b) === 1),
);
check(
  'messaging_product survives both branches',
  [phoneBody, bsuidBody].every(b => b.messaging_product === 'whatsapp'),
);
check(
  'and so does the message payload itself',
  [phoneBody, bsuidBody].every(b => b.type === 'text'),
);

// ── the webhook change router ───────────────────────────────────────────────
// Before this existed the route flat-mapped `change.value.messages` and ignored
// `change.field`, so a user_id_update — a change with no messages array at all —
// was dropped without a trace. These fixtures are the record of what each field
// is supposed to produce.
interface Fixture {
  id: string;
}
function changes(...list: unknown[]) {
  return { entry: [{ changes: list as never[] }] };
}

const onlyMessages = routeWebhookChanges<Fixture>(
  changes({ field: 'messages', value: { messages: [{ id: 'wamid.1' }, { id: 'wamid.2' }] } }),
);
eq('a messages change yields its messages', onlyMessages.messages.length, 2);
eq('and no rotations', onlyMessages.rotations.length, 0);
eq('and nothing unhandled', onlyMessages.unhandledFields.length, 0);
eq('message objects pass through untouched', onlyMessages.messages[0]?.id, 'wamid.1');

// The compatibility branch. Meta always sets `field`, but the route this
// replaces never read it — so any payload that worked before must still work,
// including a test harness that omits it. Dispatching on the field alone would
// silently drop real messages, the one regression this change must not have.
const fieldless = routeWebhookChanges<Fixture>(changes({ value: { messages: [{ id: 'wamid.3' }] } }));
eq('a field-less change still yields its messages', fieldless.messages.length, 1);
eq('and is not reported as unhandled', fieldless.unhandledFields.length, 0);

const rotated = routeWebhookChanges<Fixture>(
  changes({
    field: 'user_id_update',
    value: {
      user_id_update: [
        {
          wa_id: waId,
          user_id: { previous: 'PT.111', current: 'PT.222' },
          // Present on the wire for multi-portfolio businesses; we are one
          // portfolio, so it must be parsed and DROPPED, never carried forward.
          parent_user_id: 'US.ENT.11815799212886844830',
        },
      ],
    },
  }),
);
eq('a rotation yields ZERO messages', rotated.messages.length, 0);
eq('and one rotation', rotated.rotations.length, 1);
eq('the old id', rotated.rotations[0]?.previous, 'PT.111');
eq('the new id', rotated.rotations[0]?.current, 'PT.222');
eq('the phone is carried for logs only', rotated.rotations[0]?.waId, waId);
eq(
  'the parent BSUID is dropped, not carried',
  Object.keys(rotated.rotations[0] ?? {}).sort().join(','),
  'current,previous,waId',
);
eq('a rotation is never reported as an unhandled field', rotated.unhandledFields.length, 0);

// The payload shape is documented only in Meta's changelog and quoted verbatim
// by no public source, so an entry we cannot read must be COUNTED rather than
// dropped — otherwise a shape surprise is indistinguishable from no rotations.
const unreadable = routeWebhookChanges<Fixture>(
  changes({
    field: 'user_id_update',
    value: { user_id_update: [{ user_id: { current: 'PT.222' } }, { nonsense: true }, null] },
  }),
);
eq('an entry missing `previous` is not a rotation', unreadable.rotations.length, 0);
eq('and all three are counted as unreadable', unreadable.unreadableRotations, 3);

const unknownField = routeWebhookChanges<Fixture>(
  changes({ field: 'message_template_status_update', value: {} }),
);
eq('an unknown field yields no messages', unknownField.messages.length, 0);
eq('and no rotations', unknownField.rotations.length, 0);
eq('and is named once, so it is discoverable', unknownField.unhandledFields.join(','), 'message_template_status_update');

// A batch really can mix all three, and the router must not let one spoil the
// others — a rotation arriving beside a manager's question cannot cost them
// their reply.
const mixed = routeWebhookChanges<Fixture>(
  changes(
    { field: 'messages', value: { messages: [{ id: 'wamid.4' }] } },
    { field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'PT.1', current: 'PT.2' } }] } },
    { field: 'statuses', value: {} },
  ),
);
eq('a mixed batch keeps its message', mixed.messages.length, 1);
eq('its rotation', mixed.rotations.length, 1);
eq('and its unknown field', mixed.unhandledFields.join(','), 'statuses');

// Nothing about an empty or malformed envelope may throw: this runs before the
// 200 that stops Meta retrying, so a throw here becomes a redelivery storm.
const empty = routeWebhookChanges<Fixture>({});
eq('an empty body yields no messages', empty.messages.length, 0);
eq('no rotations', empty.rotations.length, 0);
eq('and nothing unhandled', empty.unhandledFields.length, 0);
const noField = routeWebhookChanges<Fixture>(changes({ value: {} }));
eq('a change with neither field nor messages is reported, not dropped', noField.unhandledFields.join(','), '(missing)');

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

// ── the 24-hour free-form window (issue #46) ────────────────────────────────
// The predicate that decides whether a briefing costs money. It is the same
// class of thing as hasWhatsAppConsent above — one wrong branch and the
// consequence is invisible — so the truth table is pinned here too.
//
// It must return true ONLY on positive proof. Everything else sends a template:
// a template always arrives, whereas free-form text outside the window is
// refused with 131047 and the person receives nothing at all.
{
  const NOW = Date.parse('2026-08-14T07:00:00.000Z');
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const HOUR = 60 * 60 * 1000;

  eq('23 hours is the window, not 24', FREE_FORM_WINDOW_MS, 23 * HOUR);

  check('a message a minute ago is inside', withinFreeFormWindow(at(60_000), NOW));
  check('a message 22 hours ago is inside', withinFreeFormWindow(at(22 * HOUR), NOW));
  check('a message 25 hours ago is outside', !withinFreeFormWindow(at(25 * HOUR), NOW));
  // The hour of deliberate margin. Meta's window is 24h; we stop at 23 so a
  // send decided at the top of a run cannot expire before it is posted.
  check(
    'THE MARGIN: 23.5 hours is outside, even though Meta would still allow it',
    !withinFreeFormWindow(at(23.5 * HOUR), NOW),
  );

  // Exactly at the boundary, both sides of it. An off-by-one here is a send
  // that Meta refuses and nobody ever sees.
  check('exactly at the margin is inside', withinFreeFormWindow(at(FREE_FORM_WINDOW_MS), NOW));
  check('one millisecond past it is outside', !withinFreeFormWindow(at(FREE_FORM_WINDOW_MS + 1), NOW));
  check('one millisecond inside it is inside', withinFreeFormWindow(at(FREE_FORM_WINDOW_MS - 1), NOW));
  check('this instant is inside', withinFreeFormWindow(at(0), NOW));

  // Every ambiguity resolves to the template.
  check('null → template', !withinFreeFormWindow(null, NOW));
  check('undefined (the column does not exist yet) → template', !withinFreeFormWindow(undefined, NOW));
  check('an empty string → template', !withinFreeFormWindow('', NOW));
  check('an unparseable timestamp → template', !withinFreeFormWindow('ontem de manhã', NOW));
  check('a date-shaped non-date → template', !withinFreeFormWindow('2026-13-45T99:00:00Z', NOW));
  // A FUTURE timestamp means the runtime clock and whatever wrote the column
  // disagree. That is exactly the situation in which "trust it, it's recent"
  // is the wrong instinct: we cannot tell how far off the other clock is, so we
  // cannot tell how much of the window is left.
  check('a timestamp one hour in the FUTURE → template', !withinFreeFormWindow(at(-HOUR), NOW));
  check('a timestamp one second in the future → template', !withinFreeFormWindow(at(-1000), NOW));
  check('a wildly future timestamp → template', !withinFreeFormWindow('2099-01-01T00:00:00Z', NOW));
}

// ── the one recoverable send failure ────────────────────────────────────────
// 131047 means "the envelope was wrong, the recipient is fine", so the briefing
// retries that person with a template inside the same notification_log claim.
// It must be recognised NARROWLY: every other failure means the send is
// genuinely broken, and re-sending it as a template would spend money to reach
// the same wall.
{
  const body = (code: number) => JSON.stringify({ error: { message: 'nope', code } });
  eq('the code is Meta\'s re-engagement error', OUTSIDE_WINDOW_ERROR_CODE, 131047);
  check('131047 is recoverable', isOutsideWindowError(new WhatsAppSendError(400, body(131047))));
  // The ones that must NOT trigger a template retry.
  check('131026 (undeliverable) is not', !isOutsideWindowError(new WhatsAppSendError(400, body(131026))));
  check('131030 (allow-list) is not', !isOutsideWindowError(new WhatsAppSendError(400, body(131030))));
  check('132000 (bad parameter) is not', !isOutsideWindowError(new WhatsAppSendError(400, body(132000))));
  // A 500 with an HTML body parses to code null — a broken gateway, not a
  // window problem.
  check('an unparseable error body is not', !isOutsideWindowError(new WhatsAppSendError(502, '<html>bad gateway')));
  check('a plain Error is not', !isOutsideWindowError(new Error('boom')));
  check('null is not', !isOutsideWindowError(null));
  check('undefined is not', !isOutsideWindowError(undefined));
  // A DIFFERENT error class carrying the same number must not qualify either:
  // the code alone is not the signal, the class is half of it.
  check('a look-alike object is not', !isOutsideWindowError({ code: 131047 }));
}

// ── the free-form briefing body (issue #46, defect 4) ───────────────────────
// "Canalização" on its own tells a plumber nothing. The free-form envelope has
// no template constraints, so it carries the description and the materials —
// the two fields that were always in task_board and could never fit in a
// one-line template parameter.
{
  function task(over: Partial<BriefingTask> = {}): BriefingTask {
    return {
      id: uuid,
      title: 'Canalização',
      job_name: 'Casa de Paco',
      overdue: false,
      days_overdue: 0,
      description: 'Substituir os tubos da cozinha.',
      materials: ['tubo PVC 50mm', 'cola', 'fita'],
      ...over,
    };
  }
  function briefing(tasks: BriefingTask[]): WorkerBriefing {
    return {
      workerId: uuid,
      name: 'Miguel',
      recipient: { kind: 'phone', waId },
      locale: 'pt-PT',
      tasks,
      lastInboundAt: null,
    };
  }

  const one = renderWorkerFreeForm(briefing([task()]));
  check('the body greets by name', one.includes('Miguel'), one);
  check('and names the task', one.includes('Canalização'), one);
  check('and its obra', one.includes('Casa de Paco'), one);
  // THE defect. Before this renderer the message was the title and nothing else.
  check('AND THE DESCRIPTION', one.includes('Substituir os tubos da cozinha.'), one);
  check('AND THE MATERIALS', one.includes('tubo PVC 50mm') && one.includes('fita'), one);
  // Newlines are the whole reason this is not a template parameter.
  check('the body uses newlines', one.includes('\n'), JSON.stringify(one));
  // Defect 3: we already know their language, so we never ask them to pick one.
  check(
    'and never explains how to change language',
    !/\bPT\b.*\bES\b.*\bEN\b/i.test(one) && !/STOP/i.test(one),
    one,
  );

  // A row with neither field degrades to what the template used to send — never
  // worse than today, only better when the data is there.
  const bare = renderWorkerFreeForm(briefing([task({ description: null, materials: [] })]));
  check('a bare task is still a complete message', bare.includes('Canalização'), bare);
  check('and invents no empty Material line', !bare.includes('Material:'), bare);

  const idle = renderWorkerFreeForm(briefing([]));
  check('a worker with nothing on still gets a message', idle.includes('Miguel'), idle);
  check('and it says so', idle.includes(getCatalog('pt-PT').reminders.workerNothing), idle);

  // Truncation. There is no second message at 07:00, so a long list is trimmed
  // rather than split.
  const manyMaterials = renderWorkerFreeForm(
    briefing([task({ materials: Array.from({ length: 20 }, (_, i) => `material ${i}`) })]),
  );
  check('a 20-item material list is truncated', !manyMaterials.includes('material 19'), manyMaterials);
  check('and says how many were left out', manyMaterials.includes('+14'), manyMaterials);
  check('while still showing the first ones', manyMaterials.includes('material 0'), manyMaterials);

  const manyTasks = renderWorkerFreeForm(
    briefing(Array.from({ length: 9 }, (_, i) => task({ title: `Tarefa ${i}` }))),
  );
  check('more than five tasks are truncated', !manyTasks.includes('Tarefa 8'), manyTasks);
  check('and the remainder is counted', manyTasks.includes('+4'), manyTasks);

  const longDescription = renderWorkerFreeForm(briefing([task({ description: 'x'.repeat(1000) })]));
  check('an essay of a description is cut', !longDescription.includes('x'.repeat(500)), 'not truncated');

  // The last-resort cap. Even a pathological row must fit one WhatsApp message,
  // because two pushes at 07:00 read worse than a trimmed one.
  const pathological = renderWorkerFreeForm(
    briefing(
      Array.from({ length: 5 }, (_, i) =>
        task({
          title: `${'T'.repeat(400)} ${i}`,
          description: 'd'.repeat(1000),
          materials: Array.from({ length: 30 }, () => 'm'.repeat(200)),
        }),
      ),
    ),
  );
  check(
    'even a pathological briefing fits one WhatsApp message',
    pathological.length <= 4000,
    `${pathological.length} chars`,
  );
  eq('so it is never split', splitForWhatsApp(pathological).length, 1);

  // Overdue-first, the same ordering the template path uses — the two envelopes
  // may differ in detail but never in which task is most urgent.
  const mixedOrder = renderWorkerFreeForm(
    briefing([
      task({ title: 'A tempo', overdue: false }),
      task({ title: 'Atrasada', overdue: true, days_overdue: 3 }),
    ]),
  );
  check(
    'the overdue task is listed first',
    mixedOrder.indexOf('Atrasada') < mixedOrder.indexOf('A tempo'),
    mixedOrder,
  );
  check('and is marked with its age', mixedOrder.includes('3'), mixedOrder);

  // Every locale must render, with no `undefined` leaking from a missing key.
  for (const locale of LOCALES) {
    const body = renderWorkerFreeForm({ ...briefing([task()]), locale });
    check(`${locale} — renders a body`, body.length > 0);
    check(`${locale} — leaks no undefined`, !body.includes('undefined'), body);
    check(`${locale} — still carries the materials`, body.includes('tubo PVC 50mm'), body);
  }
}

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

// ── the worker sink (PRD 4 / issue #22) ─────────────────────────────────────
// The crew channel is prose and nothing else. A worker's roster has no
// `propose`, no guarded write and no way to construct the ToolContext
// createProposal demands — the absence is enforced by the type checker, and
// these three checks pin the RUNTIME half of it.
//
// The throw is the interesting one. Silently skipping a card here would be the
// exact defect this file's check 1 exists for, made worse: on the worker path
// it would be the only signal that the two rosters had stopped being isolated,
// and it would arrive as nothing at all.
{
  const workerParts = [text('Hoje tens a pintura do 2.º andar.')];
  const out = planWorkerMessages(workerParts);
  eq('a worker turn is one plain text message', out.length, 1);
  eq('and it is never interactive', out[0]?.kind, 'text');

  const converted = planWorkerMessages([text('Precisas de **primário** e rolo.')]);
  eq('worker prose is markdown-converted too', converted[0]?.body, 'Precisas de *primário* e rolo.');

  eq('non-proposal tool outputs are ignored', planWorkerMessages([toolOutput({ status: 'ok', tasks: [] }), text('pronto')]).length, 1);

  eq('a silent turn sends nothing', planWorkerMessages([]).length, 0);

  const long = planWorkerMessages([text('L'.repeat(6000))]);
  check('a long worker reply is split, never truncated', long.length === 2 && long.every(m => m.body.length <= 4000));

  let threw = false;
  try {
    planWorkerMessages([card('Crear tarea: «x».')]);
  } catch {
    threw = true;
  }
  check('a proposal on the worker path THROWS rather than being dropped', threw);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nWhatsApp check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
