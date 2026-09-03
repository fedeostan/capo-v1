// The shape of a proposal-card dictionary.
//
// Functions rather than format strings with placeholders: Spanish and English
// need different word order from Portuguese ("Criar tarefa: «X» na obra Y" vs
// "Create task: 'X' on the Y job"), and a function signature lets TypeScript
// enforce that every locale accepts exactly the arguments render.ts passes.
//
// Date arguments arrive PRE-FORMATTED (via formatDate) so each template is pure
// string assembly and cannot forget to format.

import type { Locale } from '@capo/i18n/locale';

export type TaskStatus = 'pending' | 'in_progress' | 'pending_review' | 'blocked' | 'done' | 'cancelled';
export type JobStatus = 'active' | 'paused' | 'done';

export interface CardStrings {
  taskStatus: Record<TaskStatus, string>;
  jobStatus: Record<JobStatus, string>;

  /** Language names as they appear INSIDE a card sentence, declined for this
   *  locale ("de Português para Inglês"). Nine strings duplicated across the
   *  three dictionaries rather than imported from @capo/i18n's catalog, because
   *  UI copy deliberately never enters the agent bundle (see AGENTS.md). */
  languageName: Record<Locale, string>;

  /** Hand-rolled rather than Intl.DateTimeFormat: @capo/core must render the
   *  same bytes on every runtime regardless of its ICU build, because the
   *  result is persisted to proposals.rendered_text and compared on approval. */
  formatDate(iso: string): string;

  errors: {
    jobNotFound(id: string): string;
    workerNotFound(id: string): string;
    taskNotFound(id: string): string;
    emptyChange: string;
    emptyPlan: string;
    noTemplate(action: string): string;
    companyNotFound: string;
    sameLanguage: string;
    /** The company dial moved between propose and approve. This action's
     *  referential re-check — the analogue of a dangling job id. */
    languageMoved: string;
    nothingToTranslate: string;
    /** The crew request behind an apply_request_materials card is gone. Its
     *  referential check, the analogue of a dangling job id: the card names
     *  who asked and when for, and both are read back off that row. */
    requestNotFound(id: string): string;
  };

  createTask(p: {
    title: string;
    jobName?: string;
    workerName?: string;
    /** Everyone else on the SAME task (issue #44). Resolved to names by
     *  render.ts, so a dangling worker id fails before the manager sees the
     *  card — the same referential check `workerName` gets. Omitted entirely
     *  when empty; a card must never say "with nobody helping". */
    collaboratorNames?: string[];
    startDate?: string;
    dueDate?: string;
    /** Estimated length in WORKING days — the scheduler skips weekends and
     *  holidays, so each locale's wording must say working days, not days
     *  (issue #118). */
    durationDays?: number;
    /** Omitted entirely when empty, like collaboratorNames: on a create there
     *  is nothing to take off, so an empty list means the same as no list. */
    materials?: string[];
    /** The payload carries a description; the card says so without quoting
     *  it — it can be paragraphs long, and taskChange.description makes the
     *  same choice. */
    hasDescription?: boolean;
  }): string;
  updateTask(p: { title: string; changes: string[] }): string;
  taskChange: {
    title(v: string): string;
    status(v: string): string;
    assignee(v: string): string;
    /**
     * Who is helping, after this change (issue #44).
     *
     * Takes the WHOLE list rather than a diff, because the payload is a whole
     * list — set_task_collaborators replaces the set — and a card that said
     * "add João" while the payload also removed Zé would be describing one
     * thing and doing another, which is the one thing a card may never do.
     *
     * The empty array is therefore a real and different sentence, not an
     * omission: it means "take everybody off". Each locale writes its own.
     */
    collaborators(names: string[]): string;
    startDate(v: string): string;
    dueDate(v: string): string;
    /** Estimated length in WORKING days — see createTask.durationDays. */
    duration(days: number): string;
    job(v: string): string;
    /**
     * The materials list, after this change (issue #118).
     *
     * Same contract as `collaborators`, for the same reason: update_task
     * writes the array through wholesale, so the card states the RESULTING
     * list — "add grout" while the payload also dropped the tiles would be
     * describing one thing and doing another.
     *
     * The empty array is therefore a real and different sentence, not an
     * omission: it means "take every material off". Each locale writes its own.
     */
    materials(list: string[]): string;
    description: string;
  };

  createJob(p: { name: string; address?: string; clientName?: string; startsOn?: string }): string;
  updateJob(p: { name: string; changes: string[] }): string;
  jobChange: {
    name(v: string): string;
    address(v: string): string;
    client(v: string): string;
    status(v: string): string;
    startsOn(v: string): string;
    endsOn(v: string): string;
  };

  /**
   * `optIn` is the manager's consent attestation, and it buys exactly one
   * extra sentence: the ask to tell this person to reply once (issue #153).
   *
   * It lives on the CARD rather than in add_worker's return value on purpose.
   * `confirm_posture` defaults to `always_ask`, so for every manager who has
   * not changed it every add_worker is an approval card — and on that path
   * resolveProposal DISCARDS the tool result: the web route and the WhatsApp
   * handler both show the manager `rendered_text` (echoed again by
   * events.approved) and nothing else. A sentence returned from the tool would
   * therefore be invisible to almost everybody, and model-mediated for the
   * rest. Here it is deterministic and read twice — once when deciding, once
   * when it is done.
   *
   * Only when consent is being recorded AND a number is on file, because those
   * are the two conditions under which Capo will actually send a first message
   * for the person to reply to. Without them the manager's next job is the one
   * the crew card already names, and a second ask would just be noise.
   */
  addWorker(p: { name: string; trade?: string; phone?: string; optIn?: boolean }): string;
  updateWorker(p: { name: string; changes: string[] }): string;
  workerChange: {
    name(v: string): string;
    trade(v: string): string;
    phone(v: string): string;
    /** The language of this worker's daily briefing (workers.language). */
    language(v: string): string;
    /**
     * WhatsApp consent (issue #157). TWO strings, not one taking a boolean:
     * giving permission and taking it back are different events, and a card
     * that blurred them would be asking a manager to approve something the
     * sentence does not say. Consent is the gate on every proactive send, so
     * the direction has to be unmissable.
     *
     * No value is interpolated: the timestamp is minted server-side and the
     * manager is attesting to a fact, not choosing a date.
     */
    whatsappOptIn: string;
    whatsappOptOut: string;
  };

  /** The counts are ROW counts, re-read from the DB at render time rather than
   *  carried in action_args, so the card can never disagree with the payload.
   *  Zero-count categories must be omitted, not printed as "0 obras". */
  translateCompany(p: {
    fromLanguage: string;
    toLanguage: string;
    tasks: number;
    jobs: number;
    workers: number;
    memories: number;
    undoDays: number;
  }): string;

  /** The cascade diff (apply_reschedule).
   *
   *  A manager can only judge a schedule change as a BEFORE and an AFTER, so
   *  every row carries both sides. `fromStart`/`fromDue` are absent for a task
   *  that had no dates at all (start_date null means "unscheduled" — the board
   *  falls back to created_at), and each locale writes its own word for that.
   *
   *  `unverified` says the trigger was DECLARED finished and not yet checked.
   *  It has to be on the card because that is the whole shape of the feature:
   *  the cascade fires on a claim, which is why it can only ever propose. */
  reschedule: {
    header(p: {
      reason: 'early_completion' | 'late_completion' | 'manual';
      jobName: string;
      count: number;
      unverified: boolean;
      triggerTitle?: string;
      /** Working days the trigger beat (negative) or missed (positive) its due date. */
      triggerShiftDays?: number;
    }): string;
    row(p: {
      title: string;
      fromStart?: string;
      fromDue?: string;
      toStart: string;
      toDue: string;
      shiftDays: number;
    }): string;
    /** Long cascades are truncated; the count must be exact — rendered_text is
     *  the persisted audit artifact, quoted byte-identically on resolution. */
    more(n: number): string;
    jobEnd(p: { from?: string; to: string }): string;
  };

  /** Putting an obra on hold with no restart date (apply_job_pause, issue #95).
   *
   *  The card has to make TWO things unmissable, because approving it is not
   *  reversible from anything the payload stores: the dates listed are being
   *  ERASED rather than moved, and the tasks themselves stay exactly where
   *  they are. A manager who reads "pause" and expects the board to look the
   *  same tomorrow has been misled by the card, not by the feature. */
  jobPause: {
    header(p: { jobName: string; count: number; alreadyPaused: boolean }): string;
    row(p: { title: string; fromStart?: string; fromDue?: string }): string;
    /** Long lists are truncated; the count must be exact — rendered_text is
     *  the persisted audit artifact, quoted byte-identically on resolution. */
    more(n: number): string;
    /** The last line: what does NOT happen. */
    footer: string;
  };

  /** What the crew asked for, going onto a task's buy list
   *  (apply_request_materials, issue #152 follow-up).
   *
   *  ⚠ THIS CARD MAY NOT QUOTE THE CREW MEMBER, and the signature is what
   *  enforces it: there is no parameter the words could go in, the same shape
   *  renderCheckinAnswerEvent keeps and for the same reason. `rendered_text` is
   *  quoted into an `event` row in `messages` when the manager taps, and
   *  `messages` is the table thread.recentUserTexts reads. So a quote on this
   *  card is worker-authored prose in the manager's own thread, which is the
   *  one thing 0027, 0043 and AGENTS.md all forbid. Adding a `text` parameter
   *  here breaks that boundary and `scripts/rls-isolation-matrix.mjs`'s
   *  checkWorkerTextIsolation is what would catch it.
   *
   *  What the manager gets instead: the crew member's NAME (typed by the
   *  manager on the crew screen), the day it is needed for, the task and the
   *  obra, the exact lines being added, what is already on the list, and a
   *  pointer to the notifications where the words are already rendered as an
   *  attributed quote. */
  requestMaterials: {
    header(p: {
      workerName: string;
      taskTitle: string;
      jobName?: string;
      /** Pre-formatted, like every other date on a card. Absent means the crew
       *  member never said when, which is a first-class answer (0043) and must
       *  be shown as undated rather than guessed at. */
      neededBy?: string;
    }): string;
    /** One line being ADDED. Never a line being removed: this card only ever
     *  appends, so there is no "before" to show per row. */
    row(material: string): string;
    /** What the task already carries, so the manager can see he is not being
     *  asked to buy the same thing twice. Omitted entirely when empty. */
    existing(list: string[]): string;
    /** The last line: that approving is not cheaply undone, and where the crew
     *  member's own words are. */
    footer: string;
  };

  plan: {
    header(p: { jobName: string; count: number; from: string; to: string }): string;
    row(p: {
      index: number;
      title: string;
      from: string;
      to: string;
      days: number;
      workerName?: string;
    }): string;
    dependsOn(indices: number[]): string;
    materials(list: string[]): string;
    /** Materials-quality warnings (issue #119), appended after the task rows.
     *  Question-shaped: the card still proposes and approving is always
     *  possible — a warning turns a silent generator mistake into a question,
     *  it never blocks. When the checker finds nothing the whole section is
     *  absent, never an empty header. */
    warnings: {
      header: string;
      /** Names that look like ONE material written several ways ("Azulejo",
       *  "azulejo 30x60") — the buy list aggregates identical strings, so
       *  each spelling becomes its own line to buy. Raw spellings as the plan
       *  wrote them, first-seen order. */
      nameVariants(names: string[]): string;
      /** A same-trade sibling lists consumables this task does not — the
       *  "two tiling tasks, only one has grout" case. */
      tradeGap(p: { trade: string; title: string; missing: string[] }): string;
    };
  };
}

// System-event strings written to the conversation when a proposal resolves.
// Model-visible (they land in the thread as `event` rows) and manager-visible,
// so they follow the user locale like the cards do.
export interface EventStrings {
  rejected(renderedText: string): string;
  failed(renderedText: string, reason: string): string;
  approved(renderedText: string): string;
  unknownAction(action: string): string;
  staleArgs: string;
}
