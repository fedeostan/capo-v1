// Model-facing prompt copy, per locale.
//
// Deliberately NOT in @capo/i18n. That package is USER-facing UI copy; this is
// prompt scaffolding the manager never sees. Keeping them apart means the agent
// bundle never pulls in button labels, and a copywriting change to the app
// cannot silently alter what the model is told.
//
// The one accepted cost: the "app around you" tour in prompts/orchestration.ts
// names the bottom-nav tabs, whose real labels live in @capo/i18n. Those five
// words can drift. Importing the catalog here to fix five words would drag the
// entire UI dictionary into the agent — not worth it.

export interface PromptBlocks {
  /** Heading for the knowledge-base index block. */
  knowledgeHeading: string;
  knowledgeIntro: string;

  /** Company snapshot block. */
  snapshotHeading: string;
  /**
   * Label for the manager's own name (issue #62). It sits in the snapshot
   * rather than in the cached policy half for the same reason every other line
   * here does: it is a row in the tenant's database, read fresh each turn.
   */
  snapshotManager: string;
  snapshotCompany: string;
  snapshotActiveJobs: string;
  snapshotActiveWorkers: string;
  snapshotOpenTasks: string;
  snapshotPendingProposals: string;

  /** Onboarding steering. */
  firstUse: string;
  incompleteSetup(gaps: string[]): string;
  gapNoJobs: string;
  gapNoWorkers: string;

  /** Durable memory block. */
  memoryHeading: string;
  memoryEmpty: string;

  /** Conversation summary block. */
  summaryHeading: string;

  /** Transcript speaker labels used by the summarizer. */
  speakers: { user: string; assistant: string; event: string };
  emptyMessage: string;
}
