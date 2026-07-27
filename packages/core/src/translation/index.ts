// Tenant-wide data translation.
//
// Consumed by BOTH the agent (capabilities/translate*.ts) and the web app
// (/perfil actions + the /api/translation routes), which is why it sits beside
// capabilities/ rather than inside it.
//
// IMPORT RULE: nothing under translation/ may import from capabilities/.
// capabilities/render.ts imports countTranslatable from here to build the
// approval card, so the reverse direction is a cycle.

export { TRANSLATABLE, TRANSLATABLE_TABLES, fieldsFor } from './scope';
export type { TranslatableField, TranslatableTable } from './scope';
export { countTranslatable } from './count';
export type { TranslationCounts } from './count';
export { collectTranslatable, loadGlossary } from './collect';
export type { CollectedItem } from './collect';
export {
  ActiveBatchError,
  createTranslationBatch,
  getBatchStatus,
  revertTranslationBatch,
  runTranslationBatch,
} from './run';
export type { BatchStatus } from './run';
