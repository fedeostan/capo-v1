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

/** Every template this repo knows how to submit. */
export function allTemplates(): TemplateDefinition[] {
  return [...capoDailyBriefing(), ...capoTaskCheckin(), ...capoWelcome()];
}

/** Templates `status` checks for existence and approval, definition or not. */
export const MANAGED_TEMPLATE_NAMES = ['capo_daily_briefing', 'capo_task_checkin', 'capo_welcome'];

/** The three locale codes every managed template must exist in. */
export const TEMPLATE_LANGUAGES = LOCALES.map(l => getCatalog(l).reminders.templateLanguage);
