import type { Locale } from '@capo/i18n/locale';
import type { CardStrings, EventStrings } from './types';
import { cards as ptPT, events as ptPTEvents } from './pt-PT';
import { cards as esES, events as esESEvents } from './es-ES';
import { cards as enUS, events as enUSEvents } from './en-US';

export type { CardStrings, EventStrings, TaskStatus, JobStatus } from './types';

export const cards: Record<Locale, CardStrings> = {
  'pt-PT': ptPT,
  'es-ES': esES,
  'en-US': enUS,
};

export const events: Record<Locale, EventStrings> = {
  'pt-PT': ptPTEvents,
  'es-ES': esESEvents,
  'en-US': enUSEvents,
};
