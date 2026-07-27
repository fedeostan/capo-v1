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
//
// Run with `pnpm whatsapp-check`. Exit 0 = green, 1 = at least one failure.

import type { UIMessage } from 'ai';
import {
  parseProposalButtonId,
  planAssistantMessages,
  proposalButtonId,
  splitForWhatsApp,
  toWhatsAppMarkdown,
  type ApprovalLabels,
} from '@capo/core/channels/whatsapp';

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
