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

/** One line of the onboarding checklist: how it stands, and what is there. */
export interface OnboardingItem {
  status: string;
  detail: string;
}

/**
 * The live state of the initial setup, as the model is shown it. `allDone` is
 * not derived from the four items here on purpose: the caller owns the rule for
 * what counts as complete, and the block's closing instruction changes with it.
 */
export interface OnboardingChecklist {
  about: OnboardingItem;
  jobs: OnboardingItem;
  crew: OnboardingItem;
  tasks: OnboardingItem;
  allDone: boolean;
}

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
  /**
   * Label for the address of the manager's own dashboard. A live fact like the
   * rest of this block, and for a blunt reason: the agent runs in a package
   * that reads no environment at all, so before this line existed there was no
   * URL anywhere in its context and any link it produced would have been
   * invented.
   */
  snapshotApp: string;

  /** Onboarding steering. */
  firstUse: string;
  incompleteSetup(gaps: string[]): string;
  gapNoJobs: string;
  gapNoWorkers: string;

  /**
   * The driving block shown while `companies.onboarded_at` is null (issue: a
   * new manager's onboarding stopped halfway). It REPLACES
   * `firstUse`/`incompleteSetup` for as long as the company is unfinished:
   * those two are a nudge, this is a checklist the model is told to keep
   * working through until every line is done.
   *
   * Each item arrives already rendered as a status word plus a detail string,
   * so there is one template per locale rather than four, and the single
   * definition of what "done" means for each item stays with the caller.
   */
  onboarding(checklist: OnboardingChecklist): string;
  /** Checklist item statuses. */
  onboardingDone: string;
  onboardingMissing: string;
  /** Item details, rendered from the live counts by the caller. */
  onboardingAbout(value: string | null): string;
  onboardingJobs(count: number, withClient: number, withAddress: number): string;
  onboardingCrew(count: number, withPhone: number, withConsent: number): string;
  onboardingTasks(count: number): string;

  /** Durable memory block. */
  memoryHeading: string;
  memoryEmpty: string;

  /** Conversation summary block. */
  summaryHeading: string;

  /** Transcript speaker labels used by the summarizer. */
  speakers: { user: string; assistant: string; event: string };
  emptyMessage: string;
}
