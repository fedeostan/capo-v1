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
    job(v: string): string;
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

  addWorker(p: { name: string; trade?: string; phone?: string }): string;
  updateWorker(p: { name: string; changes: string[] }): string;
  workerChange: {
    name(v: string): string;
    trade(v: string): string;
    phone(v: string): string;
    /** The language of this worker's daily briefing (workers.language). */
    language(v: string): string;
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
