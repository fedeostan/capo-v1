// The Meta message templates Capo submits, version-controlled.
//
// A template is user-facing product copy that a third party reviews
// asynchronously, and the approved text is what a worker actually reads. Doing
// this by hand in WhatsApp Manager means "what exactly did we submit, and in
// which language" is a question you answer by squinting at a dashboard — which
// is the state capo_daily_briefing is in today: docs/whatsapp-cloud-api-runbook.md
// §6 records only a Portuguese example, prefixed "For example".
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

/**
 * capo_task_checkin — the 16:30 "did you finish today's tasks?" template.
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

/** Every template this repo knows how to submit. */
export function allTemplates(): TemplateDefinition[] {
  // capo_daily_briefing is deliberately absent. It was created by hand in
  // WhatsApp Manager before this script existed and is already approved, so a
  // definition for it here would be one nobody has verified against the live
  // template — worse than no definition, because it would look authoritative.
  // `status` still reports on it by name.
  return capoTaskCheckin();
}

/** Templates `status` checks for existence and approval, definition or not. */
export const MANAGED_TEMPLATE_NAMES = ['capo_daily_briefing', 'capo_task_checkin'];

/** The three locale codes every managed template must exist in. */
export const TEMPLATE_LANGUAGES = LOCALES.map(l => getCatalog(l).reminders.templateLanguage);
