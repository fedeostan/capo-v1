// The Meta message templates Capo submits, version-controlled.
//
// A template is user-facing product copy that a third party reviews
// asynchronously, and the approved text is what a worker actually reads. Doing
// this by hand in WhatsApp Manager means "what exactly did we submit, and in
// which language" is a question you answer by squinting at a dashboard — which
// is the state capo_daily_briefing was in until its pt_PT-only, hand-made
// approval turned into a daily 132001 for every recipient on another locale.
//
// Consumed by scripts/whatsapp-template.mts (submits them, diffs them against
// what Meta holds) and scripts/whatsapp-check.mts (asserts their shape in CI,
// with no credentials and no network).

import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES, type Locale } from '@capo/i18n/locale';

export interface TemplateComponent {
  type: string;
  [key: string]: unknown;
}

export interface TemplateDefinition {
  name: string;
  /** Meta's underscore locale code. Comes from reminders.templateLanguage. */
  language: string;
  category: 'UTILITY';
  /** {{1}}, {{2}} rather than {{name}} — matches sendWhatsAppTemplate, which
   *  sends positional body parameters and nothing else. */
  parameter_format: 'POSITIONAL';
  components: TemplateComponent[];
}

// Body text per locale.
//
// Deliberately NOT in @capo/i18n: these strings never render in the app, only
// in a Meta submission, and putting them in the catalog would ship three
// sentences nobody can call into every client bundle.
//
// Each one starts AND ends with literal text. Meta rejects a body that begins
// or ends with a parameter — see the runbook. {{1}} is the worker's name and
// {{2}} the task list, both rendered by renderWorkerBriefing().
const CHECKIN_BODY: Record<Locale, string> = {
  'pt-PT': 'Olá {{1}}, tudo bem? Hoje tinhas: {{2}}. Já terminaste?',
  'es-ES': 'Hola {{1}}, ¿qué tal? Hoy tenías: {{2}}. ¿Ya has terminado?',
  'en-US': 'Hi {{1}}. Today you had: {{2}}. All finished?',
};

// Meta requires a sample value for every parameter and validates the count on
// submit. Realistic ones, containing the ' · ' separator and the '(obra)'
// parenthesis that renderWorkerBriefing actually emits, so the reviewer sees
// what a worker will see.
const CHECKIN_EXAMPLE: Record<Locale, [name: string, taskList: string]> = {
  'pt-PT': ['Miguel', 'Pintar paredes (Casa de Paco) · Assentar azulejos'],
  'es-ES': ['Miguel', 'Pintar paredes (Casa de Paco) · Alicatar el baño'],
  'en-US': ['Miguel', 'Paint the walls (Casa de Paco) · Tile the bathroom'],
};

// The 07:00 briefing body, same shape: {{1}} the recipient's name, {{2}} the
// one-line summary. One template serves BOTH audiences — renderWorkerBriefing
// for a worker and renderManagerBriefing for the manager — so the wording has
// to read correctly for either.
//
// ── THE LANGUAGE LINE IS GONE FROM HERE (issue #49, complaint 2) ────────────
// It used to read "Responde PT, ES ou EN para mudar de idioma, ou STOP para
// deixar de receber." Federico's complaint was that the first half was on EVERY
// single message — and it was, unavoidably, because a template body is fixed at
// approval time and no code in this repository can make part of it conditional.
//
// So it moved into the {{2}} PARAMETER, which is ours. reminders.languageHint
// carries the sentence and renderWorkerBriefing appends it only for a crew
// member who has never chosen a language AND has never written to us. The STOP
// half stays: Meta expects a utility template to state its opt-out, and it is
// one clause rather than two.
//
// ⚠ THIS IS A MANUAL GO-LIVE STEP. Meta has no API to rewrite an approved
// name+language pair, so editing these strings changes NOTHING live until the
// three locales are updated by hand in WhatsApp Manager and re-approved.
// `pnpm whatsapp-template status` prints a WARN for every one that has not been.
// Until then a first-contact worker reads the language options twice — which is
// strictly better than every worker reading them every morning, and it heals
// itself the moment the template is updated. See
// docs/whatsapp-cloud-api-runbook.md.
const BRIEFING_BODY: Record<Locale, string> = {
  'pt-PT': 'Bom dia {{1}}. Hoje tens: {{2}}. Responde STOP para deixar de receber.',
  'es-ES': 'Buenos días {{1}}. Hoy tienes: {{2}}. Responde STOP para dejar de recibir.',
  'en-US': 'Good morning {{1}}. Today you have: {{2}}. Reply STOP to unsubscribe.',
};

const BRIEFING_EXAMPLE: Record<Locale, [name: string, summary: string]> = {
  'pt-PT': ['Miguel', 'Pintar paredes (Casa de Paco) · Assentar azulejos'],
  'es-ES': ['Miguel', 'Pintar paredes (Casa de Paco) · Alicatar el baño'],
  'en-US': ['Miguel', 'Paint the walls (Casa de Paco) · Tile the bathroom'],
};

/**
 * capo_daily_briefing — the 07:00 briefing template.
 *
 * ⚠ This definition was written AFTER the pt_PT template was already approved.
 * pt_PT was created by hand in WhatsApp Manager before this script existed, so
 * the live pt_PT body may not match BRIEFING_BODY above; `pnpm whatsapp-template
 * status` prints a WARN when it doesn't, and the fix is to edit the live
 * template in WhatsApp Manager to match — Meta has no API to rewrite an
 * approved name+language pair, and `create` answers 2388023 for one that
 * already exists.
 *
 * It is defined here now because es_ES and en_US were never created at all,
 * which is a live failure: every 07:00 run writes a `failed` notification_log
 * row reading `template name (capo_daily_briefing) does not exist in en_US` for
 * any recipient on that locale.
 *
 * No BUTTONS component — replies to the briefing are free text (PT/ES/EN/STOP,
 * and since issue #49 also AJUDA/MENU), not quick replies. Only
 * capo_task_checkin declares buttons, and scripts/whatsapp-check.mts pins that
 * asymmetry.
 *
 * Note what this template is NOT used for any more, most mornings: a crew
 * member who has written to us in the last 23 hours gets the free-form
 * briefing, or the interactive LIST version of it, both of which say far more
 * than a one-line parameter can and cost nothing. This template is the envelope
 * for people we have never heard from.
 */
export function capoDailyBriefing(): TemplateDefinition[] {
  return LOCALES.map(locale => ({
    name: 'capo_daily_briefing',
    language: getCatalog(locale).reminders.templateLanguage,
    category: 'UTILITY' as const,
    parameter_format: 'POSITIONAL' as const,
    components: [
      {
        type: 'BODY',
        text: BRIEFING_BODY[locale],
        example: { body_text: [BRIEFING_EXAMPLE[locale]] },
      },
    ],
  }));
}

/**
 * capo_task_checkin — the late-afternoon "did you finish today's tasks?" template.
 *
 * BUTTON ORDER IS A CONTRACT. Index 0 is "done", index 1 is "not_done", and
 * /api/cron/checkin mints checkinPayload('done', …) at index 0. Swapping them
 * here — or in WhatsApp Manager — inverts every answer, and the Graph API
 * answers the send with a cheerful 200. scripts/whatsapp-check.mts pins the
 * repo side of that contract; `pnpm whatsapp-template status` pins the live
 * side.
 */
export function capoTaskCheckin(): TemplateDefinition[] {
  return LOCALES.map(locale => {
    const t = getCatalog(locale);
    return {
      name: 'capo_task_checkin',
      language: t.reminders.templateLanguage,
      category: 'UTILITY' as const,
      parameter_format: 'POSITIONAL' as const,
      components: [
        {
          type: 'BODY',
          text: CHECKIN_BODY[locale],
          example: { body_text: [CHECKIN_EXAMPLE[locale]] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: t.whatsapp.checkinDoneButton }, // index 0 → 'done'
            { type: 'QUICK_REPLY', text: t.whatsapp.checkinNotDoneButton }, // index 1 → 'not_done'
          ],
        },
      ],
    };
  });
}

/**
 * capo_welcome — the first thing Capo ever says to somebody (issue #45).
 *
 * Sent once per person, ever, the first time their number can legally be
 * messaged: a crew member whose manager has recorded their consent, or a
 * manager who has ticked the box on /perfil.
 *
 * ── WHY THE BODY IS BUILT FROM THE CATALOG ─────────────────────────────────
 * Unlike the two templates above, this one has a free-form TWIN. When the
 * recipient happens to be inside their 24-hour window the welcome goes out as
 * ordinary text instead — free, and rendered by renderWelcomeFreeForm() in
 * apps/web/app/notifications/welcome.ts from `welcomeGreeting` / `welcomeStop`.
 *
 * Two copies of the same sentence, one here and one in the catalog, would
 * eventually disagree, and the symptom would be that Capo introduces itself
 * differently depending on an invisible property of the recipient. So the fixed
 * halves are READ FROM THE CATALOG and the parameter is substituted straight
 * into the greeting: welcomeGreeting('{{1}}') is literally the approved
 * opening. scripts/whatsapp-check.mts pins that the two envelopes still agree.
 *
 * ── ONE TEMPLATE, TWO AUDIENCES ────────────────────────────────────────────
 * A crew member and a manager need to be told very different things, and there
 * is exactly one thing in this repository that can say them: {{2}}. The fixed
 * body cannot — an approved template body is frozen until it is re-submitted by
 * hand and re-reviewed, which is precisely how the daily briefing ended up
 * telling every worker how to change language every single morning (#49). So
 * `welcomeWorker` and `welcomeManager` are both {{2}}, and changing either one
 * needs no approval at all.
 *
 * No BUTTONS component. A reply of any kind opens the free 24-hour window, and
 * the crew already have STOP, PT/ES/EN and MENU as whole-message keywords; a
 * quick-reply button would be a FOURTH tappable payload shape to keep disjoint
 * from the other three for no gain (AGENTS.md).
 */
const WELCOME_EXAMPLE_NAME = 'Miguel';
const WELCOME_EXAMPLE_COMPANY = 'Construções Silva';

export function capoWelcome(): TemplateDefinition[] {
  return LOCALES.map(locale => {
    const t = getCatalog(locale).reminders;
    return {
      name: 'capo_welcome',
      language: t.templateLanguage,
      category: 'UTILITY' as const,
      parameter_format: 'POSITIONAL' as const,
      components: [
        {
          type: 'BODY',
          text: `${t.welcomeGreeting('{{1}}')} {{2}} ${t.welcomeStop}`,
          // The worker wording is the sample, not the manager's: it is the far
          // more common send, and it is the one a Meta reviewer should judge —
          // it names the business, states what will arrive, and offers the
          // language choice, which is the whole case for the template being
          // UTILITY rather than MARKETING.
          example: { body_text: [[WELCOME_EXAMPLE_NAME, t.welcomeWorker(WELCOME_EXAMPLE_COMPANY)]] },
        },
      ],
    };
  });
}

/**
 * capo_daily_briefing_v2 — the 07:00 briefing, laid out for a person (issue #108).
 *
 * The original capo_daily_briefing is a single frozen sentence, so everything
 * a worker reads is one line with tasks glued together by ' · '. A template
 * body is frozen at approval, but the body's own LINE BREAKS are ours to
 * declare at submission time — so v2 is the same envelope with the parameter
 * on its own paragraph: greeting, blank line, {{2}}, blank line, opt-out.
 *
 * Under #108's B-then-A decision, {{2}} on this path carries a short personal
 * knock ("Tens 3 tarefas hoje — responde OK para veres o detalhe"), and the
 * full formatted briefing arrives free-form after the worker's reply opens the
 * 24h window. The knock is ONE flat sentence, which is exactly what a Meta
 * body parameter can hold — toTemplateParam flattens newlines, so a
 * multi-line {{2}} was never available anyway.
 *
 * A NEW NAME rather than an edit: Meta has no API to rewrite an approved
 * name+language pair, and the send path must be able to fall back to the old
 * template until every locale of this one is approved. The language line
 * ("Responde PT, ES ou EN") stays out of the body — that is #49's lesson and
 * the one thing #108 says any re-approval must not reintroduce. STOP stays:
 * Meta expects a utility template to state its opt-out.
 *
 * No BUTTONS component — same asymmetry as capo_daily_briefing, pinned by
 * scripts/whatsapp-check.mts: briefing replies are free text, only
 * capo_task_checkin declares buttons.
 */
const BRIEFING_V2_BODY: Record<Locale, string> = {
  'pt-PT': 'Bom dia {{1}}.\n\n{{2}}\n\nResponde STOP para deixar de receber.',
  'es-ES': 'Buenos días {{1}}.\n\n{{2}}\n\nResponde STOP para dejar de recibir.',
  'en-US': 'Good morning {{1}}.\n\n{{2}}\n\nReply STOP to unsubscribe.',
};

const BRIEFING_V2_EXAMPLE: Record<Locale, [name: string, knock: string]> = {
  'pt-PT': ['Miguel', 'Tens 3 tarefas hoje — responde OK para veres o detalhe.'],
  'es-ES': ['Miguel', 'Tienes 3 tareas hoy — responde OK para ver el detalle.'],
  'en-US': ['Miguel', 'You have 3 tasks today — reply OK to see the details.'],
};

export function capoDailyBriefingV2(): TemplateDefinition[] {
  return LOCALES.map(locale => ({
    name: 'capo_daily_briefing_v2',
    language: getCatalog(locale).reminders.templateLanguage,
    category: 'UTILITY' as const,
    parameter_format: 'POSITIONAL' as const,
    components: [
      {
        type: 'BODY',
        text: BRIEFING_V2_BODY[locale],
        example: { body_text: [BRIEFING_V2_EXAMPLE[locale]] },
      },
    ],
  }));
}

/**
 * capo_message_waiting — the window-reopener (issue #123, Part B).
 *
 * A manager wants to reach a crew member NOW, outside the 24h window free-form
 * text is legal in. The flow: hold the manager's words server-side, send this
 * template, and the worker's reply — any reply — opens the window and flushes
 * the held message. So this body's one job is to make replying feel natural
 * while saying nothing the manager didn't: the held text itself must never
 * ride a frozen template body, and anything that varies rides a parameter
 * (#49's lesson). {{1}} is the worker's name; {{2}} is who is asking —
 * the company name the manager typed, never worker-authored text.
 *
 * Submitted EARLY and ahead of its code half on purpose: Meta approval takes
 * minutes to days, and the code half (the held-message table) is useless
 * until every locale of this is approved. No BUTTONS — a reply of any kind
 * opens the window, and a quick-reply would be a fourth tappable payload
 * shape to keep disjoint from the other three for no gain (AGENTS.md).
 */
const MESSAGE_WAITING_BODY: Record<Locale, string> = {
  'pt-PT': 'Olá {{1}}. {{2}} tem um recado para ti — responde a esta mensagem para o receberes. Responde STOP para deixar de receber.',
  'es-ES': 'Hola {{1}}. {{2}} tiene un mensaje para ti — responde a este mensaje para recibirlo. Responde STOP para dejar de recibir.',
  'en-US': 'Hi {{1}}. {{2}} has a message for you — reply to this message to receive it. Reply STOP to unsubscribe.',
};

const MESSAGE_WAITING_EXAMPLE: Record<Locale, [name: string, sender: string]> = {
  'pt-PT': ['Miguel', 'Construções Silva'],
  'es-ES': ['Miguel', 'Construcciones Silva'],
  'en-US': ['Miguel', 'Silva Construction'],
};

export function capoMessageWaiting(): TemplateDefinition[] {
  return LOCALES.map(locale => ({
    name: 'capo_message_waiting',
    language: getCatalog(locale).reminders.templateLanguage,
    category: 'UTILITY' as const,
    parameter_format: 'POSITIONAL' as const,
    components: [
      {
        type: 'BODY',
        text: MESSAGE_WAITING_BODY[locale],
        example: { body_text: [MESSAGE_WAITING_EXAMPLE[locale]] },
      },
    ],
  }));
}

/**
 * capo_task_assigned — "your boss just gave you a new task for today" (issue W7).
 *
 * The out-of-window half of the immediate assignment note. Inside the crew
 * member's own 24-hour window Capo sends the whole day as free text, free of
 * charge and with the /dia link; outside it, free-form is refused (131047) and
 * this is the only legal way to reach them.
 *
 * ── {{2}} IS THE TASK, NOT THE DAY ─────────────────────────────────────────
 * A template parameter is ONE FLAT LINE — toTemplateParam flattens whitespace
 * and Meta rejects a newline with 132000 — so the day does not fit. The body
 * therefore names what is NEW and asks for a reply, and the reply is the point:
 * it opens the free window, and #108's existing "OK" keyword answers it with
 * the full formatted briefing. One flow, reached two ways.
 *
 * ── NO URL BUTTON, DELIBERATELY ────────────────────────────────────────────
 * A link to /dia would be the obvious thing to put here and it is not
 * available: a URL button is a different component, a different approval path,
 * and the /dia token is minted per person per day so it could only ever be a
 * dynamic URL suffix. "Responde OK" reaches the same page's content through a
 * flow that already exists and already works.
 *
 * No BUTTONS component at all, for the standing reason: a quick reply would be
 * a FOURTH tappable payload shape to keep disjoint from the other three
 * (AGENTS.md), and any reply already opens the window.
 *
 * The body states STOP, as every non-buttoned template here does: Meta expects
 * a utility template to say how to stop receiving them.
 */
const TASK_ASSIGNED_BODY: Record<Locale, string> = {
  'pt-PT': 'Olá {{1}}, o teu chefe deu-te uma tarefa nova para hoje: {{2}}. Responde OK para veres o teu dia. Responde STOP para deixar de receber.',
  'es-ES': 'Hola {{1}}, tu jefe te ha dado una tarea nueva para hoy: {{2}}. Responde OK para ver tu día. Responde STOP para dejar de recibir.',
  'en-US': 'Hi {{1}}, your boss gave you a new task for today: {{2}}. Reply OK to see your day. Reply STOP to unsubscribe.',
};

const TASK_ASSIGNED_EXAMPLE: Record<Locale, [name: string, tasks: string]> = {
  'pt-PT': ['Miguel', 'Pintar paredes (Casa de Paco)'],
  'es-ES': ['Miguel', 'Pintar paredes (Casa de Paco)'],
  'en-US': ['Miguel', 'Paint the walls (Casa de Paco)'],
};

export function capoTaskAssigned(): TemplateDefinition[] {
  return LOCALES.map(locale => ({
    name: 'capo_task_assigned',
    language: getCatalog(locale).reminders.templateLanguage,
    category: 'UTILITY' as const,
    parameter_format: 'POSITIONAL' as const,
    components: [
      {
        type: 'BODY',
        text: TASK_ASSIGNED_BODY[locale],
        example: { body_text: [TASK_ASSIGNED_EXAMPLE[locale]] },
      },
    ],
  }));
}

/** Every template this repo knows how to submit. */
export function allTemplates(): TemplateDefinition[] {
  return [
    ...capoDailyBriefing(),
    ...capoTaskCheckin(),
    ...capoWelcome(),
    ...capoDailyBriefingV2(),
    ...capoMessageWaiting(),
    ...capoTaskAssigned(),
  ];
}

/** Templates `status` checks for existence and approval, definition or not. */
export const MANAGED_TEMPLATE_NAMES = [
  'capo_daily_briefing',
  'capo_task_checkin',
  'capo_welcome',
  'capo_daily_briefing_v2',
  'capo_message_waiting',
  'capo_task_assigned',
];

/** The three locale codes every managed template must exist in. */
export const TEMPLATE_LANGUAGES = LOCALES.map(l => getCatalog(l).reminders.templateLanguage);
