// The user-facing copy catalog.
//
// Hand-written interface rather than `typeof ptPT`: that way all three
// dictionaries are checked against the SAME contract, symmetrically. Each
// dictionary declares `const dict: Catalog = { … }` — a type ANNOTATION, not
// `satisfies` and not `as const` — so a missing key AND a typo'd extra key are
// both `tsc --noEmit` errors, which is already a CI gate.
//
// Values may be functions (interpolation), which is exactly why components
// receive `locale` and call getCatalog() themselves rather than being handed a
// catalog as a prop: functions cannot cross the RSC server→client boundary.
//
// ── FEDERICO: this whole file is product voice. The pt-PT dictionary carries
// the microcopy dials that used to live as TODOs in the components; es-ES and
// en-US are translations of it and will need your ear. ──

export interface Catalog {
  meta: {
    /** Value for <html lang>. */
    htmlLang: string;
    /** BCP-47 tag for Intl.DateTimeFormat. */
    dateLocale: string;
    appName: string;
    appDescription: string;
    /** This language's own name, for the picker. */
    languageName: string;
    /** Suffix on page titles, e.g. "Hoje — Capo". */
    titleSuffix: string;
  };

  nav: {
    home: string;
    chat: string;
    tasks: string;
    jobs: string;
    materials: string;
    activity: string;
    profile: string;
  };

  /** The persistent top bar and the profile drawer.
   *
   *  Every icon-only control in the bar is labelled from here rather than
   *  hardcoded, and that is a requirement rather than tidiness: each of these
   *  strings is spoken aloud by a screen reader, and Capo speaks three
   *  languages — a hardcoded default would announce "Open menu" on a
   *  Portuguese screen.
   *
   *  `rooms` are the five sections behind the drawer. `Billing` points at the
   *  existing /subscricao rather than a new route, so its copy lives here
   *  while its screen does not. */
  shell: {
    openMenu: string;
    profile: string;
    search: string;
    /** Said on hover/long-press only. Search does not exist in Capo at all;
     *  the control ships disabled rather than as a no-op click handler, so
     *  assistive technology is not told it works. */
    searchUnavailable: string;
    voiceNote: string;
    newTask: string;
    close: string;
    /** The manager's role, shown under their name in the drawer header. Not
     *  read from the database: Capo has no role model, and inventing one in a
     *  header is how a fictional feature gets built later to justify a label. */
    role: string;
    version: (v: string) => string;
    rooms: {
      personal: { title: string; sub: string };
      team: { title: string; sub: string };
      billing: { title: string; sub: string };
      privacy: { title: string; sub: string };
      settings: { title: string; sub: string };
    };
    /** The row ships; the deletion does not. `unavailable` is the line that
     *  makes the disabled confirm button honest instead of broken. */
    deleteAccount: {
      row: string;
      cannotUndo: string;
      title: string;
      body: string;
      placeholder: string;
      cancel: string;
      confirm: string;
      unavailable: string;
    };
  };

  /** The Activity feed (Round 3) and Home's "what just happened" widget. ONE
      block for both, because they render the same events from the same loader
      — two vocabularies would let the tab and the widget describe the same
      event differently, and the manager would have no way to tell which was
      right. */
  activity: {
    title: string;
    subtitle: string;
    empty: string;
    today: string;
    yesterday: string;
    /** A crew member filed a completion claim. */
    claimed: (task: string, who: string) => string;
    /** …and the same, when nobody is named (the manager declared it). */
    claimedAnon: (task: string) => string;
    approved: (task: string) => string;
    rejected: (task: string) => string;
    photos: (count: number, task: string) => string;
    checkinDone: (who: string) => string;
    checkinNotDone: (who: string) => string;
  };

  /** The Home launchpad (Round 2). */
  home: {
    greetingMorning: (name: string) => string;
    greetingAfternoon: (name: string) => string;
    greetingEvening: (name: string) => string;
    /** "3 obras activas · 12 tarefas abertas" */
    summary: (sites: number, openTasks: number) => string;
    nextUp: string;
    allTasks: string;
    nothingToday: string;
    decision: string;
    decisionMore: (n: number) => string;
    openTask: string;
    whatHappened: string;
    seeActivity: string;
    crew: string;
    checkedIn: (answered: number, total: number) => string;
    silent: (n: number) => string;
    noCrew: string;
    materialsLow: string;
    allMaterials: string;
    materialsNone: string;
  };

  common: {
    signOut: string;
    save: string;
    backToLogin: string;
    notAuthenticated: string;
  };

  /** The pull-to-refresh gesture, on every screen inside the app shell. The
      affordance itself is a wordless spinner (iOS convention); this is the
      aria-live announcement, the only copy a sighted user never sees. */
  pullToRefresh: { refreshing: string };

  chat: {
    title: string;
    tagline: string;
    placeholder: string;
    send: string;
    typing: string;
    /** Cancels an in-flight response. */
    stop: string;
    /** Heading of the failure card. A chat that fails silently is unusable. */
    errorTitle: string;
    /** Why it failed, in terms the manager can act on. */
    errorHints: Record<'billing' | 'auth' | 'network' | 'generic', string>;
    retry: string;
    dismiss: string;
    emptyThread: string;
    proposalTitle: string;
    pendingProposals: string;
    approve: string;
    reject: string;
    /** Shown on the button being pressed while the decision is applied.
     *  Approving a 15-task plan writes 15 rows and then refetches the RSC
     *  tree; without a label that window reads as a frozen app. */
    deciding: string;
    cardState: Record<'approved' | 'rejected' | 'failed' | 'not_pending' | 'error', string>;
    /** Keyed by tool name; unknown tools fall back to the raw name. */
    toolLabels: Record<string, string>;
  };

  mic: {
    record: string;
    stop: string;
    noAccess: string;
    notUnderstood: string;
    error: string;
  };

  dashboard: {
    taskStatus: Record<'pending' | 'in_progress' | 'pending_review' | 'blocked' | 'done' | 'cancelled', string>;
    /** Full phrase, e.g. "Prazo passou há 3 dias" / "3 days past due". */
    overdueBy(days: number): string;
    noAssignee: string;
    /** A bare name reads as a label; "Assigned to João" reads as a fact. */
    assignedTo(name: string): string;
    noJob: string;
    noDate: string;
    /** Section headings on the wide "Todas" board (issue #96). Deliberately
     *  the same words as the Hoje / Amanhã / Atrasadas chips: a heading and a
     *  chip that hold the same tasks must not be named differently. */
    agendaToday: string;
    agendaTomorrow: string;
    agendaOverdue: string;
    talkToCapo: string;
    /** Secondary line on a board row grouped by obra, e.g. "até 12/03". */
    dueBy(shortDate: string): string;
    /** Why a task is flagged. A risk badge with no reason is just a colour. */
    risk: {
      blocked: string;
      lateStart: string;
      dueSoon: string;
      lateDependency(titles: string[]): string;
      pausedJob: string;
    };
    /** e.g. "4 de 9 concluídas (44%)" */
    progress(done: number, total: number, pct: number): string;
    /** e.g. "4 de 9 tarefas concluídas" */
    tasksDone(done: number, total: number): string;
    noTasksRegistered: string;
    overdueCount(n: number): string;
    pendingCount(n: number): string;
    /** An obra whose work is on hold (issue #95). A badge, never a warning
     *  colour: pausing a site is a normal thing a manager does. */
    jobPaused: string;
    /** One line saying what pausing actually means, so "em pausa" is never
     *  read as "something is broken" or "this is gone". */
    jobPausedHint: string;
    dependsOn(titles: string[]): string;
  };

  /** The in-app inbox, plus the strip in the app shell that leads to it.
   *  Top-level rather than under `screens` because it spans two surfaces —
   *  the strip renders on every authenticated screen. */
  notifications: {
    title: string;
    subtitle: string;
    empty: string;
    /** The shell strip. COUNTED on purpose: "you have news" is not
     *  actionable and "3 novidades" is. */
    banner(n: number): string;
    markAllRead: string;
    failed: string;
    /** Accessible name for the unread dot, which is otherwise colour alone. */
    unread: string;
    /** The row on /perfil — the way in when nothing is unread and the strip
     *  is therefore absent. */
    profileLink: string;
    /** One line per kind, given the subject's OWN NAME (a task title, stored
     *  in companies.language). The name is data: interpolated, never
     *  translated. Keyed by the `kind` check constraint in
     *  0023_notifications.sql, so widening that constraint without adding
     *  copy in all three dictionaries is a tsc error. */
    kind: Record<'review_pending' | 'worker_request', (subject: string) => string>;
    /** Stand-in when the row carries no title — an unnamed task. */
    noSubject: string;
    /** Label above the worker's quoted note. Sits ABOVE it and is never
     *  merged into it: same attribution rule as the review control, because
     *  it is the same worker-authored text. */
    noteLabel: string;
    /** Sends the manager where the decision actually gets made — the board,
     *  not the inbox. */
    openSubject: string;
    /** The inbox's one-line pointer at the /perfil opt-in card. Triggers no
     *  permission prompt itself — the prompt is one-shot and must stay behind
     *  a deliberate press. */
    pushNudge: string;
    pushNudgeLink: string;
  };

  /**
   * ── FEDERICO: what the crew ASKED FOR (issue #152). ──
   *
   * A crew member on site tells Capo they need something — paint, a grinder, a
   * skip, anything — and it reaches you: in the inbox, on your lock screen, on
   * Home, and on WhatsApp when you are already mid-conversation with Capo.
   * Before this, Capo told them to phone you themselves.
   *
   * Two rules govern every string below.
   *
   * FIRST: their words are QUOTED AND ATTRIBUTED, never rewritten into Capo's
   * voice. `quote` and `text` here always carry what one person typed on a
   * building site, and the copy around them exists to make that obvious — the
   * same rule the review note follows, for the same reason (AGENTS.md, on
   * worker-authored text).
   *
   * SECOND: urgency is a DATE, never a tone. `when` renders the result of plain
   * subtraction against today, and `undated` is a real answer that must read as
   * a fact rather than an apology — Capo asks once and does not guess.
   */
  requests: {
    /** Home's section heading. */
    title: string;
    /** Link out of the Home card, to the inbox where the full record lives. */
    seeAll: string;
    /** "+2 pedidos" beneath the rows Home shows. */
    more(n: number): string;
    /**
     * The coarse filing hint, keyed by the `category` CHECK in
     * 0043_worker_requests.sql — the same tsc-error device notifications.kind
     * uses. Deliberately coarse: an enum here is a list of things a person on
     * site is allowed to need, so 'other' is a first-class answer and the real
     * content is always the quote.
     */
    category: Record<'material' | 'tool' | 'machine' | 'delivery' | 'other', string>;
    /**
     * When it is needed FOR, as a sentence fragment ("para amanhã").
     *
     * `kind` comes from subtracting today from `needed_by`; `dateLabel` is
     * already formatted in the reader's own locale and is null for every branch
     * except 'later' and 'overdue'. 'undated' must not read as a complaint
     * about the crew member — nobody did anything wrong, we simply do not know.
     */
    when(args: {
      kind: 'overdue' | 'today' | 'tomorrow' | 'later' | 'undated';
      dateLabel: string | null;
    }): string;
    /** Label above the quoted words, naming who wrote them. Sits ABOVE the
     *  quote and is never merged into it. */
    quoteLabel(name: string): string;
    /**
     * The free-form WhatsApp line to the manager, sent only inside their own
     * 24-hour window. Carries the quote, attributed. `task` is the title of the
     * task they named, or null — company-owned text either way.
     */
    whatsapp(args: { name: string; when: string; quote: string; task: string | null }): string;
    /**
     * The manager's CHAT-THREAD note.
     *
     * ⚠ It takes NO quote and must never be given one. A `role='event'` row is
     * permanent, model-visible input read by thread.recentUserTexts — the
     * evidence pool the write guard matches a manager's quote against. Our own
     * copy, a crew name the MANAGER typed, a date and a task title: that is the
     * complete list of what may be in this sentence. See
     * apps/web/app/notifications/thread.ts for why that is a safety boundary
     * and not a style rule.
     */
    event(args: { name: string; when: string; task: string | null }): string;
  };

  /**
   * ── FEDERICO: Perfil → Mensagens automáticas (issue #51). ──
   *
   * The screen that answers "what does Capo send my crew, when, and did it
   * actually go out?" On 13 August the morning message arrived 49 minutes late
   * and nothing in the product could say so — the answer took a hosting-company
   * log. Every string below exists to make one of those facts readable.
   *
   * The COST copy is the important product judgement here and it is stated
   * twice on purpose: every recipient of every send is a paid WhatsApp
   * template, so a schedule screen is also a spending screen.
   */
  automations: {
    title: string;
    subtitle: string;
    /** The row on /perfil that leads here. */
    profileLink: string;
    /** Standing note at the top: what a scheduled message costs. */
    costNote: string;

    /** Plain-language name and purpose of each predefined send. Keyed by the
     *  job_kind CHECK in 0036, so adding a job without adding copy in all
     *  three dictionaries is a tsc error. */
    job: Record<'daily_briefing' | 'task_checkin', { name: string; what: string; who: string }>;

    /** "Aimed at 07:00, arrives between 07:00 and 08:59." The window is said
     *  out loud because the platform's dispatch really does drift by up to an
     *  hour, and promising a precision we do not have is what made a late
     *  message read as a broken one. */
    aimedAt(hour: string): string;
    window(from: string, to: string): string;
    nextRun(when: string): string;
    /** Shown when the company has never chosen — i.e. everybody, today. */
    usingDefault: string;
    on: string;
    off: string;
    /** The switch. Turning a send off is the one control here that can only
     *  ever reduce spend. */
    enabledLabel: string;
    hourLabel: string;
    saved: string;
    saveFailed: string;
    invalidHour: string;

    /** Why a manager cannot add a third send. Stated rather than hidden: a
     *  greyed-out button with no explanation is worse than an honest
     *  paragraph. */
    addTitle: string;
    addExplanation: string;

    historyTitle: string;
    historyHint: string;
    historyEmpty: string;
    /** The one column this whole issue exists for. */
    due: string;
    ran: string;
    lateBy(minutesLabel: string): string;
    onTime: string;
    /** Per-run tallies. */
    messagedCount(n: number): string;
    failedCount(n: number): string;
    skippedCount(n: number): string;
    /** The liveness signal: a day on which a paying company sent nothing. */
    nothingSent: string;

    debugTitle: string;
    debugHint: string;
    /** One line per person, per run. */
    recipientWorker: string;
    recipientManager: string;
    /** Plain-language outcome for one recipient. */
    outcome: Record<'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'pending', string>;
    outcomeHint: Record<'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'pending', string>;

    /** Why somebody got nothing at all — the reasons that never produce a send
     *  record, and were therefore invisible from inside the product. */
    reasonTitle: string;
    reason: Record<
      'noConsent' | 'unreachable' | 'inactive' | 'managerNoConsent' | 'noManagerAccount',
      string
    >;
    /** Named right now, from the current crew — the counts are historical, the
     *  names are today's. Said out loud so the two are not confused. */
    reasonNamesHint: string;
    reasonNobody: string;

    /** Meta's numeric failure codes, explained. The bare code is shown
     *  alongside, because it is what a support conversation needs. */
    metaError: Record<'132001' | '131030' | '131026' | '131047' | '131021' | '132000', string>;
    metaErrorUnknown: string;
    metaErrorLabel(code: number): string;
  };

  /**
   * Perfil → Memória (issue #48): what Capo remembers, and how to make it
   * forget.
   *
   * This screen exists because memory the manager cannot inspect is a trust
   * problem, not a feature. Everything here is written to be readable by
   * somebody who has never heard the words "context window" — the explainer is
   * the screen's main job, and the list is the evidence for it.
   */
  memory: {
    title: string;
    subtitle: string;
    /** The row on /perfil that leads here. */
    profileLink: string;
    /** One paragraph teaching what "memory" means here. */
    explainer: string;

    companyHeading: string;
    companyHint: string;
    personalHeading: string;
    personalHint: string;
    empty: string;

    /**
     * The cap, said out loud rather than applied silently. A screen that hid
     * the fact that older notes stop being carried would make Capo look
     * forgetful for no visible reason.
     */
    capTitle: string;
    capHint(carried: number, limit: number): string;
    storedNotCarried: string;

    forget: string;
    forgotten: string;
    forgetFailed: string;
    /** What "forget" actually does — marked, not erased. */
    forgetNote: string;

    /**
     * Keyed by the `kind` CHECK in 0001, so adding a kind without adding copy
     * in all three dictionaries is a tsc error — the same device
     * notifications.kind uses.
     */
    kind: Record<'company' | 'job' | 'worker' | 'preference' | 'fact', string>;

    /** The night shift's liveness signal. */
    reviewTitle: string;
    lastReviewed(when: string): string;
    neverReviewed: string;
    reviewHint: string;
  };

  /** The /perfil opt-in card for lock-screen alerts. Every state is spelled
   *  out because the failure modes here are all SILENT: an iPhone that was
   *  never installed, and a permission that was denied once and can never be
   *  asked for again, both look identical to "it just doesn't work". */
  push: {
    title: string;
    subtitle: string;
    enable: string;
    enabled: string;
    disable: string;
    working: string;
    failed: string;
    /** Shown when the permission prompt was refused. No button follows it:
     *  JavaScript cannot re-ask, ever. */
    deniedTitle: string;
    deniedHelp: string;
    /** iOS delivers push only to a home-screen-installed PWA. */
    iosTitle: string;
    iosHelp: string;
    iosLink: string;
  };

  screens: {
    tasks: {
      title: string;
      /** Chip labels. Keyed by the URL param value, which stays Portuguese —
       *  it's a link contract, not copy. */
      quando: Record<'hoje' | 'amanha' | 'atrasadas' | 'risco' | 'todas', string>;
      empty: Record<'hoje' | 'amanha' | 'atrasadas' | 'risco' | 'todas', string>;
      emptyForDate: string;
      emptyFallback: string;
      /** Narrows an empty-state line to the selected obra. */
      emptyInJob(base: string): string;
      count(n: number): string;
      filterByJob: string;
      filterByDay: string;
      allJobs: string;
      jobStatusSuffix: Record<'paused' | 'done', string>;
    };
    jobs: { title: string; subtitle: string; empty: string };
    /** One line at the top of a paused site's own screen (issue #95): what
     *  pausing does and, just as importantly, what it does not do. */
    jobDetail: { fallbackTitle: string; empty: string; paused: string };
    taskActions: { complete: string; reopen: string; failed: string };
    /** The pending-review control on a board row. Separate from taskActions
     *  because these three buttons resolve a REVIEW, not a task. */
    taskReview: {
      /** Attributes the note to its author. The worker's own words are quoted
       *  BELOW this line, never merged into it — see the note handling rule in
       *  0018_task_reviews.sql. */
      declaredBy(name: string): string;
      /** Header when declared_by_worker_id is null (manager opened the check). */
      declaredByManager: string;
      /** Header when a worker filed the claim but their name did not resolve
       *  (e.g. their crew row is gone or invisible while the review is still
       *  pending). Still attributes to a worker, not the manager — never fall
       *  back to declaredByManager here. */
      declaredByUnknownWorker: string;
      approve: string;
      reject: string;
      /** "No check needed" — the manager closing it without a site visit. */
      dismiss: string;
      /** Opens a review from the task detail screen. */
      request: string;
      failed: string;
      /** ── WHETHER THE CLAIM CAME WITH PROOF (issue #52) ──────────────────
       *  Two doors lead into `pending_review` and they used to disagree about
       *  evidence: the worker agent requires at least one photo at the schema
       *  level, a check-in button tap required nothing. Now that a tap can be
       *  followed by a photo, the manager needs to see which they are looking
       *  at BEFORE they approve.
       *
       *  ⚠ THIS IS A FACT, NEVER AN ACCUSATION. "No photos attached" is a
       *  true statement about a record. It must not read as "this worker did
       *  not bother" — most claims have no photo for perfectly ordinary
       *  reasons (the manager filed the check themselves, the crew member was
       *  already off site, the task is one nobody photographs). Do not add a
       *  warning colour, an exclamation mark, or the word "missing".
       *
       *  Counted from `task_photos` at READ time, so it is true whenever the
       *  screen is looked at rather than whenever the claim was filed.
       *
       *  ONE pair of keys for three surfaces — the board row, the task detail
       *  screen and the in-app inbox all read exactly these, the same way push
       *  and inbox share one headline entry so they cannot say different
       *  things about the same row. */
      proofNone: string;
      proofPhotos(n: number): string;
    };
    taskDetail: {
      /** Page title when the task cannot be named (metadata runs before the row loads). */
      fallbackTitle: string;
      backToTasks: string;
      assignee: string;
      /** An active worker with no phone gets no 07:00 WhatsApp briefing. */
      assigneeNoPhone: string;
      assigneeInactive: string;
      /** The assignee line is a button now. This is what it says when nobody
       *  is assigned — an invitation, not a hole in the screen. */
      assignUnassigned: string;
      /** Heading of the picker sheet. */
      assignTitle: string;
      /** Names the day availability was worked out for, e.g. "Livre a 14/08?".
       *  Saying the date matters: the answer is only true for that one day. */
      assignAvailabilityOn(shortDate: string): string;
      /** Shown instead when the task has no start date and no deadline, so
       *  there is no day to check anybody against. Must say plainly that Capo
       *  cannot tell — never imply everyone is free. */
      assignAvailabilityUnknown: string;
      /** Badge on a worker with nothing else on that day. */
      assignFree: string;
      /** Badge on a worker who already has work that day, with how much. */
      assignBusy(n: number): string;
      /** Said out loud when every worker is busy, so the manager does not have
       *  to infer it from the badges. The list is still shown below it —
       *  double-booking stays possible, it is just no longer accidental. */
      assignNoneFree: string;
      /** No active crew at all. */
      assignNoWorkers: string;
      /** Marks the person the task already belongs to. */
      assignCurrent: string;
      /** Clears the assignee. */
      assignRemove: string;
      assignCancel: string;
      assignFailed: string;

      // ── collaborators (issue #44) ──────────────────────────────────────────
      // The assignee above is the LEAD and stays the accountable person. These
      // name the OTHER people on the same single task — the whole point being
      // that "Miguel e o João fazem a pintura" is one task with one materials
      // list, not two tasks with two.
      /** Section heading for the helpers on this task. */
      collaborators: string;
      /** Shown in the section when nobody is helping — an invitation, not a hole. */
      collaboratorsNone: string;
      /** Heading of the multi-select sheet. */
      collaboratorsTitle: string;
      /** Sub-line of that sheet. Must make clear this never changes the lead. */
      collaboratorsHint: string;
      /** Marks the LEAD inside the picker list — they are shown, never tappable:
       *  hiding them would read as a bug, and letting them be picked would mean
       *  somebody helping themselves. */
      collaboratorsLead: string;
      /** Confirm button on the sheet. Named for what it does to the set. */
      collaboratorsSave: string;
      collaboratorsFailed: string;
      dates: string;
      startDate: string;
      dueDate: string;
      /** Plan durations are WORKING days — say so, or "3 days" reads as calendar days. */
      durationDays(days: number): string;
      description: string;
      noDescription: string;
      materials: string;
      job: string;
      help: string;
      askCapo: string;
      /** Prefills the chat with the task in context. */
      askCapoPrompt(title: string): string;
      knowledge: string;
      knowledgeHint: string;
    };
    /** The completion sheet ("Concluir" now asks for proof first), plus the
     *  photo strip the same photos land in on the task detail screen. One key
     *  for both: the section heading and the two source labels must agree
     *  across the screen that produces photos and the screen that shows them. */
    taskPhotos: {
      sheetTitle: string;
      /** Says what a useful photo IS, in one line. A manager who has to guess
       *  photographs the sky. */
      sheetIntro: string;
      addPhotos: string;
      /** While the browser is re-encoding what was just picked. Can take a
       *  second or two for six photos on an old phone — silence there reads as
       *  a frozen app. */
      preparing: string;
      /** e.g. "Up to 6 photos, 5 MB each." Both numbers come from
       *  @capo/core/media/photos so the copy cannot drift from the limit. */
      limitHint(max: number, megabytes: number): string;
      remove: string;
      /** Primary button, e.g. "Complete with 3 photos". */
      confirm(n: number): string;
      /** The escape hatch. Plain and unhidden on purpose — see the note in
       *  completion-sheet.tsx. */
      skip: string;
      cancel: string;
      sending: string;
      /** Heading of the photo strip on the task detail screen. */
      sectionTitle: string;
      /** Attribution under each photo. A photo the crew sent and one the
       *  manager took are different claims about the same work. */
      sourceWorker: string;
      sourceManager: string;
      /** Keyed by TaskPhotoFailure (apps/web/lib/task-photos.ts) plus a
       *  generic fallback. The server action translates the machine-readable
       *  reason through this map — the client renders whatever it catches
       *  verbatim, so anything missing here would reach the manager in
       *  English, or as raw Postgres. */
      errors: Record<
        'mime' | 'too_large' | 'empty' | 'too_many' | 'unknown_task' | 'upload_failed' | 'generic',
        string
      >;
    };
    taskHelp: {
      title: string;
      /** Says where the excerpts come from and that they are not advice. */
      intro: string;
      empty: string;
      failed: string;
      backToTask: string;
      category: Record<'lei' | 'regulamento' | 'tecnica' | 'material' | 'fabricante', string>;
    };
    materials: {
      title: string;
      subtitle: string;
      // ── issue #154: the today horizon, which asks a different question ──
      // Tomorrow and the week are ANTICIPATION — what to buy, what to order.
      // Today is not: it is "is it there?", answered by walking the site. It
      // is the only horizon with ticks, and the copy has to say so or the
      // three sections read as one list with an extra control on top.
      /** Heading for what today's work needs on site. */
      today: string;
      /** Says what the ticks are for, and that they reset overnight. */
      todayHint: string;
      emptyToday: string;
      /** The tick: this material is on site. */
      onSite: string;
      /** The tick: this material is NOT on site. */
      missing: string;
      /** Running tally on the today heading, e.g. "3 de 7 em obra". */
      checkedCount(onSite: number, total: number): string;
      /** The tick did not save. Shown beside the chip, never swallowed. */
      checkFailed: string;
      /** Heading for what must be on site tomorrow — the buy-tonight list. */
      tomorrow: string;
      /** Heading for the rest of the week — the order-tonight list. */
      week: string;
      weekHint: string;
      emptyTomorrow: string;
      /** e.g. "for: Tiling, Grouting". */
      forTasks(tasks: string[]): string;
      /** Prompt on the Tasks board when tomorrow needs materials. */
      pending(n: number): string;
      pendingHint: string;
    };
    // ── issue #60: collapsible obra groups on /materiais, and adding/editing
    // a task's materials from both /materiais and the task detail screen.
    // Kept as its own block rather than folded into `materials` above so the
    // read-only anticipation copy and the editing copy stay separable.
    materialsEdit: {
      /** Count on a group header, e.g. "4 materiais". */
      groupCount(n: number): string;
      /** An obra with work in this horizon but nothing recorded yet. */
      groupEmpty: string;
      /** Link out of an expanded group to the obra screen. */
      seeJob: string;
      /** Opens the editor from a group on /materiais. */
      add: string;
      /** Opens the editor from the task detail screen. */
      edit: string;
      /** Sheet heading while the manager picks WHICH task the material is for.
       *  Materials belong to a task, never to an obra — a group covering
       *  several tasks has to ask rather than guess. */
      pickTask: string;
      pickTaskHint: string;
      /** How many materials a task already carries, in the task chooser. */
      taskCount(n: number): string;
      /** Sheet heading while editing one task's list. */
      title(task: string): string;
      placeholder: string;
      addRow: string;
      /** Accessible name of the ✕ on a row. */
      removeRow: string;
      /** The task's list is empty and nothing has been typed yet. */
      empty: string;
      save: string;
      saving: string;
      cancel: string;
      /** Returns to the task chooser. */
      back: string;
      failed: string;
      /** The group has no task that could carry a material. */
      noTasks: string;
    };
  };

  profile: {
    title: string;
    company: string;
    yourAccount: string;
    team: string;
    teamEmpty: string;
    teamEmptyCta: string;
    noContact: string;
    inactive: string;
    /** e.g. "Today 2 · Tomorrow 1 · 5 open". */
    workerLoad(today: number, tomorrow: number, open: number): string;
    /** An active worker with no phone silently receives nothing at 07:00. */
    noWhatsAppWarning: string;
    /**
     * The second way to be silently unreachable, since 0025: a number on file
     * but no recorded WhatsApp consent. Must read as an ACTION for the manager
     * ("ask them"), not as an error — the fix is a conversation on site, and
     * then telling Capo about it.
     */
    noConsentWarning: string;
    receivesWhatsApp: string;

    /**
     * The FOURTH state (issue #153), sitting BETWEEN consent and
     * `receivesWhatsApp` — a number on file, consent recorded, and this person
     * has still never written to Capo.
     *
     * The copy has to be precisely true, because the obvious sentence ("they
     * get no messages until they reply") is FALSE and would send the manager
     * chasing the wrong thing. The 07:00 message is a paid Meta TEMPLATE and
     * goes out on the manager's recorded consent alone. What a first reply
     * unlocks is everything free-form: Capo answering at all, the /dia day
     * link (the template is pinned to two parameters with no button, so the
     * link can only ride a free-form message), and the tappable list instead
     * of plain text. So: Capo can talk AT them, not WITH them.
     *
     * Read from `workers.last_inbound_at` (0030), which is written by exactly
     * one thing — a webhook delivery Capo resolved to that worker — so a value
     * there is proof of a complete round trip, not merely of a send.
     */
    awaitingFirstReply: string;
    /**
     * The same state, escalated ONCE after several days of silence
     * (FIRST_REPLY_CHASE_DAYS on the crew page). Deliberately a change of
     * wording and tone on the SAME line rather than a new banner: a permanent
     * warning is wallpaper within a week.
     */
    awaitingFirstReplyChase(p: { days: number }): string;
    /** Label on the wa.me link that opens WhatsApp with the message below
     *  already typed. The manager presses send; Capo sends nothing. */
    firstReplyAction: string;
    /**
     * The prefilled message itself. It must read as the MANAGER's own words to
     * their crew member — never as Capo talking — because it is sent from the
     * manager's own phone and is signed by whoever forwards it. Short: managers
     * ask their crew to do things all day; they need the words, not a workflow.
     */
    firstReplyMessage(p: { name: string }): string;

    /**
     * The cost of recording consent for the CREW (issue #45). Each person Capo
     * is newly allowed to message gets one welcome, and each welcome is a paid
     * WhatsApp template — so consenting a twenty-person crew is twenty paid
     * messages, not one.
     *
     * On the team card rather than in chat because this is where the manager
     * sees the whole crew at once, which is the only place the multiplication
     * is visible.
     */
    welcomeCostHint: string;
    teamHint: string;
    teamHintLink: string;
    subscription: string;
    manageSubscription: string;
    app: string;
    install: string;
    companyNameLabel: string;
    fullNameLabel: string;
    phoneLabel: string;
    errors: {
      companyName: string;
      fullName: string;
      phone: string;
      phoneTaken: string;
      save: string;
    };
  };

  /**
   * "Report a problem" — the app half of issue #120. One row in the drawer and
   * on /perfil, one page with one textarea. The WhatsApp half's strings live
   * under `whatsapp` above.
   *
   * The copy must frame the report as going to CAPO'S TEAM, not to the
   * manager or the crew — and must promise nothing about replies or fixes:
   * triage is deliberately out of scope.
   */
  report: {
    /** The drawer/index row and the page title. */
    row: { title: string; sub: string };
    /** One sentence above the form: what happens to what they write. */
    intro: string;
    label: string;
    placeholder: string;
    submit: string;
    /** The immediate confirmation state after a successful submit. */
    sent: string;
    /** The report was empty. */
    empty: string;
    /** The insert failed — honest, never pretends it was registered. */
    failed: string;
  };

  auth: {
    // Shared by every password field on the signed-out screens, so the eye
    // says the same thing on login, signup and password reset.
    showPassword: string;
    hidePassword: string;
    login: {
      title: string;
      email: string;
      emailPlaceholder: string;
      password: string;
      submit: string;
      google: string;
      forgot: string;
      createAccount: string;
      errors: Record<'credenciais' | 'link-invalido', string>;
    };
    signup: {
      title: string;
      subtitle: string;
      submit: string;
      /** Sits under the submit button, BEFORE anything is sent. Issue #99: two
       *  managers pressed "create account", assumed they were done, and went
       *  to sign in. Saying what happens next is cheaper than explaining it
       *  afterwards. */
      emailNote: string;
      haveAccount: string;
      signIn: string;
      errors: Record<'dados' | 'fechado', string>;
    };
    /**
     * The /confirmar-email screen (issue #99). ONE screen with TWO entrances,
     * because both arrivals need the same three instructions:
     *   - straight after signing up, and
     *   - after a sign-in attempt on an account whose email was never
     *     confirmed, which used to answer "wrong email or password".
     * Only `blockedNotice` distinguishes them.
     */
    confirmEmail: {
      title: string;
      /** Names the address, so a typo is visible rather than mysterious. */
      sentTo(p: { email: string }): string;
      /** Same sentence once the pending-email cookie has expired and the
       *  address is no longer known. */
      sentToUnknown: string;
      /** Sign-in entrance only: says why the password appeared to fail. */
      blockedNotice: string;
      step1: string;
      step2: string;
      step3: string;
      /** The line that stops somebody walking back here to sign in. */
      thenWhat: string;
      resend: string;
      resent: string;
      wrongEmail: string;
      alreadyConfirmed: string;
    };
    recover: {
      title: string;
      subtitle: string;
      submit: string;
      sentTitle: string;
      sentText: string;
      errors: Record<'dados', string>;
    };
    newPassword: {
      title: string;
      label: string;
      errors: Record<'curta' | 'guardar', string>;
    };
  };

  onboarding: {
    title: string;
    subtitle: string;
    companyName: string;
    companyPlaceholder: string;
    yourName: string;
    yourNamePlaceholder: string;
    phone: string;
    phonePlaceholder: string;
    phoneHint: string;
    language: string;
    languageHint: string;
    submit: string;
    errors: Record<'dados' | 'telemovel' | 'telemovel-usado' | 'guardar', string>;
  };

  // The two language dials plus the appearance dial, rendered as cards on
  // /perfil. Appearance is per DEVICE (a cookie), unlike the language pair.
  settings: {
    /** The primary card: one dial the manager thinks of as "the language". */
    language: string;
    languageHint: string;
    /** Checkbox label carrying the live counts, so the promise on screen is the
     *  same number the approval card and the batch will use. */
    translateExisting(p: { tasks: number; jobs: number; workers: number; memories: number }): string;
    /** Shown instead when there is nothing stored yet to translate. */
    translateNothing: string;
    translateWarning: string;

    /**
     * The drift notice (issue #55). Shown ONLY when the two dials disagree —
     * profiles.language (what Capo speaks to this manager) is not
     * companies.language (what Capo writes into task titles and job names).
     *
     * That state is legal and sometimes correct (a foreman who does not share
     * his crew's language), so the copy must NOT read as an error. It names
     * what is happening, says when it is deliberate, and points at the one
     * control that moves both dials together and offers to translate the rows
     * that already exist. The two language names are passed in already
     * rendered, in their own language ("Português", "English"), the same way
     * the picker on /perfil labels them.
     */
    driftBanner(p: { you: string; board: string }): string;
    driftHint: string;
    /** Link label on surfaces that are not /perfil, pointing at the fix. */
    driftAction: string;

    /** The two-dial split, demoted into a disclosure. Still needed when a
     *  Spanish-speaking foreman joins a Portuguese company. */
    advanced: string;
    advancedHint: string;
    yourLanguage: string;
    yourLanguageHint: string;
    companyLanguage: string;
    companyLanguageHint: string;
    companyLanguageWarning: string;
    appearance: string;
    appearanceHint: string;

    /**
     * The manager's own WhatsApp consent card. Meta's business-messaging policy
     * requires a recorded opt-in before any proactive template send, and the
     * manager gets the same daily briefing the crew does — being the account
     * holder is not itself agreement to be messaged on WhatsApp.
     *
     * `whatsappConsentHint` must say plainly what they are agreeing to receive
     * and that it can be withdrawn; a consent control that hides either is not
     * one. The crew's consent is recorded through chat instead, because the
     * manager is attesting on someone else's behalf there.
     */
    whatsappConsent: string;
    whatsappConsentHint: string;
    whatsappConsentOption: { yes: string; no: string };
    /** Shown when consent is on record, so the state is legible without a form. */
    whatsappConsentOn: string;
    /** Shown when it is not — the reason the daily messages are not arriving. */
    whatsappConsentOff: string;
    /**
     * What turning consent ON actually causes (issue #45): Capo introduces
     * itself on WhatsApp, once, and that introduction is a PAID template send.
     *
     * Said out loud on the control that triggers it, because the manager is
     * spending money on their own account and cannot see the bill from here.
     * One message for their own number; the crew equivalent is
     * `profile.welcomeCostHint`, where it is one message per person.
     */
    whatsappConsentCost: string;
    // Keys must match Theme in apps/web/lib/theme.ts — tsc catches drift at
    // the call site, where the index is typed as Theme. Duplicated rather than
    // imported: @capo/i18n is a zero-dependency leaf and must never reach into
    // an app. Same pattern as billing.statusLabel below.
    themeOption: Record<'light' | 'dark' | 'system', string>;

    /**
     * The confirmation posture card (profiles.confirm_posture, 0031, #57).
     *
     * The hint must state the TRADE-OFF, not just the setting: always-ask is
     * safer and costs a tap on every change, the other acts immediately when
     * Capo can quote the manager's own words back. A control whose two options
     * both sound good is a control nobody can choose between.
     *
     * Keys must match ConfirmPosture in @capo/db/posture — duplicated as string
     * literals rather than imported, because @capo/i18n is a zero-dependency
     * leaf and must never reach up into another package. Same pattern (and same
     * tripwire) as themeOption above: the call site indexes these with a
     * ConfirmPosture, so widening one union without the other fails tsc.
     */
    confirmPosture: string;
    confirmPostureHint: string;
    confirmPostureOption: Record<'always_ask' | 'trust_quote', string>;
    confirmPostureOptionHint: Record<'always_ask' | 'trust_quote', string>;

    translationRunning(p: { done: number; total: number }): string;
    translationDone(n: number): string;
    translationFailed: string;
    translationResume: string;
    revert: string;
    revertHint(days: number): string;
    reverted: string;
    revertFailed: string;

    saved: string;
    failed: string;
  };

  billing: {
    title: string;
    activated: string;
    unavailable: string;
    trialDaysLeft(days: number): string;
    trialEnded: string;
    statusLabel: Record<'active' | 'past_due' | 'canceled', string>;
    price: string;
    manage: string;
    subscribe: string;
    bannerBlocked: string;
    bannerTrial(days: number): string;
    bannerTrialEnded: string;
    /** Thrown by assertNotBlocked and surfaced to the manager (402 / inline). */
    blockedError: string;
    checkoutFailed: string;
    noSubscription: string;
  };

  install: {
    title: string;
    subtitle: string;
    alreadyInstalled: string;
    open: string;
    installButton: string;
    skip: string;
    iosStep1Before: string;
    iosStep1Share: string;
    iosStep1After: string;
    iosStep2Before: string;
    iosStep2Action: string;
    iosStep3Before: string;
    iosStep3Action: string;
    iosStep3After: string;
    genericStep1Before: string;
    genericStep2Before: string;
    genericStep2Action: string;
    genericStep2After: string;
  };

  /**
   * The WhatsApp handshake screen (issue #84) — the step between the details
   * form and the install guide, where a new manager sends Capo its first
   * message.
   */
  whatsappHandshake: {
    title: string;
    subtitle: string;
    /**
     * What WhatsApp pre-fills into the composer. Sent BY the manager TO Capo,
     * so it is written in the first person and in the manager's own language.
     * It greets AND states an intent: Capo's `firstUse` prompt block already
     * knows how to run initial setup, and this hands it the cue directly
     * instead of opening with small talk it has to answer first.
     */
    prefill: string;
    /** Primary button, mobile. */
    openButton: string;
    /** Caption under the QR code, desktop. */
    qrHint: string;
    /** Secondary link under the QR code, desktop. */
    webLink: string;
    consentLabel: string;
    consentHint: string;
    /** Status line while nothing has arrived yet. */
    waiting: string;
    /** Status line the moment the message lands. */
    arrived: string;
    /**
     * Status line after 90 seconds of silence. A QUESTION, never an error —
     * the threshold can be wrong, and the most likely cause is a phone number
     * that does not match the manager's actual WhatsApp.
     */
    stalled(phone: string): string;
    /** Link to /perfil, shown only alongside `stalled`. */
    fixNumber: string;
    skip: string;
  };

  landing: {
    metaTitle: string;
    metaDescription: string;
    ogDescription: string;
    headline: string;
    subhead: string;
    ctaPrimary: string;
    ctaSecondary: string;
    stepLabel(n: number): string;
    steps: { title: string; text: string }[];
    materialsTitle: string;
    materialsText: string;
    priceSuffix: string;
    priceNote: string;
    ctaFooter: string;
    signIn: string;
  };

  offline: { title: string; text: string };

  whatsapp: {
    /** Sent when a voice note could not be downloaded or transcribed. */
    voiceNoteFailed: string;
    /** Sent when transcription succeeded but found no speech. */
    voiceNoteEmpty: string;
    /**
     * Sent to a MANAGER when a whole turn fails — the model errored, the agent
     * loop threw, no reply was produced (issue #126: ten messages, 75 minutes,
     * total silence). Free-form text inside the window the manager's own
     * message opened seconds earlier, so it is free and in-window by
     * construction.
     *
     * ⚠ It must promise no retry — the turn is over and nothing runs again
     * until the manager writes — and must name no cause: provider detail and
     * error codes are an oracle, and the manager cannot act on them anyway.
     *
     * ⚠ It is also the SUPPRESSION MARKER. The route persists the sent apology
     * into the thread and matches recent rows against this string in EVERY
     * locale to keep repeated failures quiet (lib/turn-failure.ts), so the
     * catalog string and the sent bytes must stay identical.
     */
    turnFailed: string;

    // ── Approval cards ──────────────────────────────────────────────────
    // Deliberately NOT reusing chat.approve / chat.reject. Both fit today,
    // but this interface cannot express "max 20 chars, must be distinct":
    // someone rewording the web button to "Aprovar proposta" or adding an
    // emoji would keep tsc and ESLint green and start 400-ing every WhatsApp
    // card at runtime. Separate keys give the constraint somewhere to live.
    // (The sink also clamps to 20, so a violation truncates rather than
    // breaking delivery.)

    /** Interactive reply-button label. Max 20 chars; must differ from
     *  `rejectButton` — Meta requires button titles to be unique. */
    approveButton: string;
    /** See `approveButton`. Max 20 chars, must differ from it. */
    rejectButton: string;
    /** Body of the interactive message when the card itself exceeded Meta's
     *  1024-char interactive limit and was sent as plain text just above. */
    approvalPrompt: string;
    /** Sent after a button press — one per ProposalResolution outcome. */
    proposalApproved: string;
    proposalRejected: string;
    proposalFailed(reason: string): string;
    /** Already decided (a duplicate tap, or Meta redelivering the webhook). */
    proposalNotPending: string;
    /** resolveProposal threw — the row vanished, or the RPC failed. */
    proposalError: string;
    /** The interactive send itself failed: the card was shown with no way to
     *  act on it, but the proposal is still pending in the web chat. */
    approvalFallback: string;

    /**
     * Sent to a WORKER whose message the restricted agent cannot take — a
     * sticker, a document, a video. Workers have no account and no app, so this
     * ack exists so the reply is not met with silence, and it carries the
     * language hint because replying a keyword is the only control they have.
     *
     * Since PRD 4 this is NOT the answer to an ordinary text message: those go
     * to the worker agent (packages/core/src/agent/worker-core.ts), which
     * answers in its own words. This is the fallback for everything it cannot
     * read.
     */
    workerAck: string;
    /** Sent after a worker switches language — always in the NEW language. */
    workerLanguageChanged: string;

    // ── the guided menu (issue #49) ─────────────────────────────────────────
    // Federico's third complaint, in his words: "not a free-flowing
    // conversation, but just these pre-made boxes". A crew member picks a task
    // from a native WhatsApp list and gets its full detail back, rendered from
    // the row — no model, no cost, no chance of an invented curing time.
    //
    // Every string here has a HARD LIMIT set by Meta, and the send clamps
    // rather than failing, so an over-long translation degrades to a truncated
    // word instead of a 400. The limits are still worth respecting in the
    // dictionaries: a clamped label reads as a bug to the person holding the
    // phone.

    /** The native button that OPENS the list. Max 20 chars. */
    workerMenuButton: string;
    /** The heading above the rows. Max 24 chars. */
    workerMenuSection: string;
    /**
     * The body of the menu when it is sent in REPLY to a keyword. The 07:00
     * briefing supplies its own body — the whole rich briefing — and never uses
     * this one.
     *
     * TWO numbers, and the second is not decoration. The menu shows at most six
     * rows while `is_open` can return forty, so a worker on a long obra can be
     * told "you have 11 tasks" above a list of six with nothing saying the rest
     * were dropped. They then scroll, do not find the task they asked about,
     * and conclude the menu is broken. When `shown < total`, say so.
     */
    workerMenuBody(shown: number, total: number): string;
    /** No open tasks at all, so there is no menu to show. Plain text. */
    workerMenuEmpty: string;
    /** Row title for "I need a person, not an answer". Max 24 chars. */
    workerMenuManagerRow: string;
    /** That row's sub-line. Max 72 chars. */
    workerMenuManagerNote: string;
    /**
     * Sent when that row is tapped. This is issue #49's "off-topic questions
     * should get 'talk to your manager', not an answer", made deterministic:
     * a tap on this row never reaches a model at all.
     */
    workerMenuManagerReply: string;
    /**
     * A tapped row we could not match to one of THIS worker's own open tasks —
     * a stale menu from last week, or a row id that is not theirs.
     *
     * Deliberately one sentence for both cases. Telling the two apart would
     * turn the reply into an oracle for which task ids exist, and a crew member
     * cannot act on the difference anyway.
     */
    workerMenuUnknownTask: string;

    /**
     * Sent after a worker replies STOP, confirming they have been unsubscribed
     * from the proactive sends (the 07:00 briefing and the late-afternoon
     * check-in). Meta requires opt-outs to be honoured and this is the receipt.
     *
     * It must name the way back — a worker who cannot rejoin without asking
     * their manager will simply ask their manager to stop using Capo.
     */
    workerOptedOut: string;
    /** Sent after a worker replies START, confirming they will hear from Capo again. */
    workerOptedIn: string;

    // ── The restricted worker agent (PRD 4) ─────────────────────────────────
    /**
     * The daily cap is spent — for this crew member, or for the whole company.
     *
     * ONE string for both ceilings on purpose. Telling a worker "your company
     * has used its allowance" invites them to work out whose messages spent it,
     * and neither version is something they can act on differently. What it
     * must do is name the way forward that still works: their supervisor.
     *
     * Sent with ZERO model calls, which is the entire point of the cap.
     */
    workerBudgetReached: string;
    /**
     * The agent turn failed — a model timeout, a database error, a deploy that
     * landed ahead of migration 0027.
     *
     * Silence here reads as "Capo is broken", the same failure mode the voice-
     * note path already guards against. Deliberately says nothing about what
     * went wrong: a worker cannot act on the difference, and an error surface
     * that varies with the cause is an oracle.
     */
    workerAgentFailed: string;
    /**
     * A photo arrived but could not be taken in — too large for the 5 MiB cap,
     * an unsupported format, or Meta's short-lived media URL expiring first.
     *
     * Must be actionable, because the worker is standing there holding the
     * phone that took it: ask for it again.
     */
    workerPhotoFailed: string;

    // ── The late-afternoon check-in ──────────────────────────────────────────────
    /**
     * The two QUICK_REPLY labels on the capo_task_checkin template. Meta caps a
     * TEMPLATE quick-reply button at 25 chars — not the 20 an interactive reply
     * title gets — and the two must differ.
     *
     * These are NOT sent at runtime: they are baked into the template Meta
     * approved. They live here so the copy has one home — scripts/whatsapp-
     * templates.ts reads them when it submits, and `pnpm whatsapp-template
     * status` diffs them against what Meta actually holds. Editing a string
     * here does NOT change the live template; it needs a re-submit and a fresh
     * approval, which is exactly what that diff is there to catch.
     *
     * The ORDER is a contract: done is button index 0, notDone is index 1, and
     * /api/cron/checkin mints its payloads in that order. Swapping them inverts
     * every answer, and the Graph API returns a cheerful 200.
     */
    checkinDoneButton: string;
    /** See `checkinDoneButton`. Max 25 chars, must differ from it. */
    checkinNotDoneButton: string;
    /**
     * SUPERSEDED by the three `checkinDone*` strings below (issue #54) and kept
     * only so nothing that still reads it breaks. Do not wire it back up: it
     * says the answer was recorded and says nothing about the manager, which
     * was true when a tap wrote only to `worker_checkins` and is misleading now
     * that it files a completion claim.
     */
    checkinDone: string;
    /**
     * Sent after a worker taps "done" and at least one of the day's tasks is
     * now waiting for the manager (issue #54).
     *
     * ⚠ It must NEVER say the task is done. A tap is a claim, not a
     * verification — the task sits in `pending_review`, stays on the manager's
     * board and is still counted overdue if its dates say so. A worker told
     * "feito" who sees the same task on tomorrow's 07:00 briefing concludes
     * Capo is broken, which is the failure this whole feature exists to end.
     */
    checkinDoneAwaiting: string;
    /**
     * Sent after a worker taps "done" when there was nothing left to claim —
     * every task in the afternoon's snapshot had already been closed by the
     * manager. The answer is still recorded; there is simply no approval
     * pending.
     */
    checkinDoneNothing: string;
    /**
     * Sent after a worker taps "done" when the answer was recorded but the
     * claim could not be filed. Says both halves out loud rather than implying
     * success: the one thing worse than a failure here is a worker who thinks
     * their manager has been told.
     */
    checkinDoneProblem: string;
    /**
     * ── THE PHOTO FOLLOW-UP (issue #52) ─────────────────────────────────────
     * Sent right after `checkinDoneAwaiting`, naming ONE claimed task and
     * asking for a photo of it. FREE-FORM text inside the 24-hour window the
     * worker's own tap opened a second earlier — never a template, so never
     * billable, and it must stay that way: a paid template to chase a photo
     * would make proof cost money per attempt.
     *
     * ⚠ IT MUST BE AN INVITATION, NOT A REQUIREMENT. The claim has ALREADY
     * been filed and stands whether or not a photo ever arrives (that is the
     * whole difference from `declare_task_done`, where `.min(1)` makes proof a
     * precondition). A sentence that reads as "send a photo or this does not
     * count" would be a lie about what just happened. Say so out loud in the
     * copy: no photo is fine.
     *
     * `task` is the task's own title, stored in companies.language and never
     * retranslated — so this must read acceptably wrapped around foreign text.
     */
    checkinPhotoAsk(task: string): string;
    /**
     * A photo landed and there is another claimed task to ask about. One task
     * at a time, deliberately: an inbound image says nothing about which task
     * it shows, and a photo filed as proof of the wrong job is worse than no
     * photo at all.
     */
    checkinPhotoNext(task: string): string;
    /**
     * A photo landed and there is nothing left to ask about.
     *
     * ⚠ Like every other acknowledgement on this path it must NEVER say the
     * task is done. The photo is proof attached to a claim that is still
     * waiting for the manager.
     */
    checkinPhotoThanks: string;
    /** Sent after a worker taps "not yet". Never scolding — the answer is
     *  useful precisely because it is safe to give.
     *
     *  This branch files NOTHING and must stay that way (issue #54). "Not yet"
     *  is an answer to a question, not a request for anything. */
    checkinNotDone: string;
    /** The worker_checkins write failed. Silence after a tap reads as "Capo is
     *  broken", the same failure mode proposalError guards against. */
    checkinError: string;
    /**
     * "Still working on it" — sent to a MANAGER when a turn is still running
     * after PROGRESS_NOTE_AFTER_MS (issue #50).
     *
     * WhatsApp's typing indicator expires after 25 seconds and vanishes without
     * a word, so a long turn (a plan, a translation) went back to looking
     * broken exactly when it was working hardest. This is the one message that
     * covers that gap. It is FREE-FORM text inside the 24-hour window the
     * manager's own message opened a moment ago — never a template, and
     * therefore never billable.
     *
     * ⚠ It must promise nothing about the OUTCOME. It is sent before the turn
     * has finished, so it cannot know whether the answer will be a result, a
     * card, or a failure. "Still on it" is the whole content.
     */
    stillWorking: string;
    /** See `stillWorking`. The crew's copy of it — same job, plainer register,
     *  and read in `workers.language`. */
    workerStillWorking: string;

    // ── "report a problem" (issue #120) ─────────────────────────────────────
    // The deterministic keyword flow, shared by BOTH sender kinds and answered
    // with zero model calls — a report about Capo must never depend on Capo's
    // model working. All three strings must frame the report as being about
    // CAPO / the app and going to CAPO'S TEAM, not to the manager: a crew
    // member describing a cement shortage here would otherwise believe their
    // boss was told.

    /** After a bare keyword ("bug"): your NEXT message is the report. Must say
     *  next-message-is-recorded plainly — that promise is what the capture
     *  branch then honours. */
    reportPrompt: string;
    /** After the report is stored. Must NOT promise a reply or a fix — triage
     *  is deliberately out of scope (#120). */
    reportAck: string;
    /** Filing failed (the likeliest cause: migration 0042 not yet applied).
     *  Honest, asks to try again — never pretends it was registered. */
    reportFailed: string;
  };

  /**
   * The daily 07:00 briefing. Worker-facing strings here are read in the
   * worker's own language (workers.language, falling back to the company's),
   * but the task TITLES they wrap are stored in companies.language and are
   * never retranslated — so these must read acceptably around foreign text.
   *
   * `renderWorkerBriefing` renders BOTH daily messages — the 07:00 briefing and
   * the late-afternoon check-in — from these strings, deliberately, so the two can never
   * drift about what "your tasks today" means. Changing the voice here changes
   * both.
   */
  /**
   * The crew day page at /dia (issue #114) — the one screen in the product a
   * person with no account ever reads.
   *
   * ── IT IS NOT A COPY OF THE MANAGER'S BOARD ────────────────────────────────
   * Everything here is written for somebody standing next to a van, in the
   * language THEY chose (`workers.language ?? companies.language`), and it must
   * never suggest an action the page cannot perform: there is no editing, no
   * "mark as done", no login. A control that is not there must not be described
   * as missing either — the page is a list, and it says so.
   *
   * The per-task lines themselves are NOT here. They come from `reminders`
   * (taskHeadline / taskDetailLines), which is what the 07:00 message renders
   * too, so the page and the message cannot describe one task differently.
   */
  dia: {
    /** <title>. Kept short: it is the browser tab on a phone. */
    title: string;
    /** "Terça, 30 de agosto" — the day this list is for, already formatted. */
    dateLine(date: string): string;
    /** Heading over today's work. `count` is the number of tasks under it. */
    todayHeading(count: number): string;
    /** Heading over work whose deadline has already passed.
     *
     *  ⚠ These tasks are in NEITHER daily WhatsApp send: `active_today` is
     *  false once a due date is behind us (0013), so the morning message
     *  structurally cannot name them. This heading is the first time the person
     *  doing the work hears about them, which is why it is a heading of its own
     *  rather than a badge mixed into the list above. */
    overdueHeading(count: number): string;
    /** Nothing on today and nothing overdue. Must read as good news, not as an
     *  error or an empty database. */
    nothing: string;
    /** Under the list: what to do with a question, given there is no control
     *  here to press. Points back at WhatsApp, which is where the person came
     *  from and where Capo can actually answer. */
    askOnWhatsApp: string;
    /**
     * Shown for a token that is unknown, expired, malformed or unreadable —
     * ALL FOUR, deliberately one sentence.
     *
     * Distinguishing "never existed" from "expired" tells somebody holding a
     * guessed string whether they guessed a real one, and there is nothing a
     * crew member could do differently with the distinction: the answer in
     * every case is "tomorrow's message has a fresh link". It must therefore
     * not read as an accusation — the overwhelmingly likely reader is a worker
     * who scrolled up to an old message.
     */
    expired: string;
    /** Heading above `expired`. */
    expiredTitle: string;
  };

  reminders: {
    /**
     * Meta template locale code — 'pt_PT', 'es_ES', 'en_US'. Underscore, not
     * hyphen. Serves both templates (capo_daily_briefing and
     * capo_task_checkin): it is the recipient's locale in Meta's format, which
     * is a property of the person, not of the message. A second per-template
     * key could only ever drift.
     */
    templateLanguage: string;
    /** Joins tasks inside the one-line template parameter. Never a newline. */
    taskSeparator: string;
    /** A task shown with the obra it belongs to. */
    taskWithJob(title: string, job: string): string;
    /** An overdue task, so it does not read like ordinary work for today. */
    taskOverdue(title: string, days: number): string;
    /** Tail when the list had to be truncated. */
    andMore(n: number): string;

    // ── who else is on this task (issue #44) ─────────────────────────────────
    // ⚠ THE CONTENT REQUIREMENT OF THE WHOLE FEATURE. A crew member who is
    // HELPING must never read a briefing that sounds like the job is theirs.
    // They get the same task, the same address and the same materials — and one
    // extra clause on the headline saying whose job it is. Get this wrong and
    // two people turn up each believing they are in charge, which is worse than
    // the duplicated-task bug this replaces.
    //
    // Applied to the headline BEFORE `taskOverdue`, so lateness stays the last
    // and most visible thing on the line.

    /** "Pintar tecto (Casa de Paco) — a ajudar Miguel". `title` already carries
     *  the obra. `lead` is the assignee's name, straight from the row. */
    taskAsCollaborator(title: string, lead: string): string;
    /**
     * The same, for a task that has collaborators and NO lead at all.
     *
     * Reachable: `tasks.assignee_worker_id` is nullable, and clearing it does
     * not remove anybody's collaborator row (deleting people's rows on an
     * unrelated edit would be worse). The wording must therefore not name
     * anyone and must not imply ownership either way.
     */
    taskAsTeam(title: string): string;
    /** The LEAD's line naming who is helping them. `names` is already joined
     *  and capped by the caller. Detail-sheet only — there is no room for it in
     *  the one-line template parameter. */
    freeFormWith(names: string): string;
    /** A worker with nothing scheduled today. */
    workerNothing: string;
    /**
     * The KNOCK — the {{2}} of the paid morning template (issue #108).
     *
     * A worker outside their 24-hour window cannot legally be sent the full
     * free-form briefing, and a template parameter is one flat line — so the
     * template no longer squeezes the task list into it. It states the size of
     * the day and asks for a reply ("responde OK"), and the reply itself opens
     * the window the full briefing then rides in on, free.
     *
     * `overdue` is how many of the day's tasks are already late; 0 means say
     * nothing about lateness. The zero-task day never reaches this string —
     * renderWorkerKnock answers `workerNothing` for it, exactly as the old
     * task-list renderer did.
     *
     * ⚠ ONE LINE, NO TRAILING FULL STOP — the same rule as `languageHint`, for
     * the same reason: until every locale of capo_daily_briefing_v2 is
     * approved, this rides {{2}} on the OLD template body too, which continues
     * "…{{2}}. Responde STOP…" straight afterwards, so a full stop here
     * renders as ".." on a live send.
     */
    workerKnock(args: { count: number; overdue: number }): string;
    /** The manager's one-line WhatsApp summary. */
    managerSummary(counts: { today: number; unassigned: number; overdue: number }): string;
    /** The manager's line when the company has nothing on today. */
    managerNothing: string;

    // ── the CHAT-THREAD notes (issue #47) ────────────────────────────────────
    // Everything above goes out over WhatsApp. These three go into the
    // company's perpetual chat thread as `role='event'` rows, which is what
    // Capo itself reads on every later turn — so they are the difference
    // between "the manager saw a message Capo has never heard of" and the two
    // of them looking at the same day.
    //
    // They are permanent and model-visible, which fixes what may be in them:
    // OUR copy, wrapped around company-owned data (crew names, counts) and
    // around structured facts (which button was tapped). Never a word a crew
    // member wrote — see apps/web/app/notifications/thread.ts for why that is a
    // safety boundary and not a style rule.
    //
    // Newlines are fine here, unlike in a template parameter.

    /**
     * The morning note: what today holds, and WHO was sent their briefing.
     * `names` is already joined and capped by the renderer, and is the empty
     * string when nobody was messaged.
     */
    managerEvent(counts: {
      today: number;
      unassigned: number;
      overdue: number;
      notified: number;
      names: string;
    }): string;
    /**
     * The late-afternoon note: who was asked whether they had finished. Same
     * `names` contract as managerEvent.
     */
    checkinEvent(args: { asked: number; names: string }): string;
    /**
     * One crew member's ANSWER to that check-in, recorded as it arrives.
     *
     * `answer` is the button they tapped — a two-valued enum minted by our own
     * cron, never anything they typed. `tasks` is how many tasks were in the
     * snapshot they were asked about, and may be 0 if that snapshot was
     * unreadable, so the copy must not depend on it.
     *
     * A "done" tap is a CLAIM, never a completion: the task lands in
     * `pending_review` and waits for the manager. This sentence must therefore
     * never say the work is finished — the same rule the worker's own
     * acknowledgement follows (checkinDoneAwaiting).
     */
    checkinAnswer(args: { name: string; answer: 'done' | 'not_done'; tasks: number }): string;
    /** Joins the crew names inside a thread note. */
    nameSeparator: string;

    // ── the FREE-FORM briefing (issue #46) ───────────────────────────────────
    // Everything above this line is squeezed into a Meta TEMPLATE parameter:
    // one line, no newlines, and wrapped by a sentence Meta approved months ago
    // that we cannot edit from this repo.
    //
    // These keys are for the other envelope. When the recipient wrote to us in
    // the last 23 hours we may answer with ordinary text, which is FREE, has no
    // approved wrapper, and may run to several lines. So this version can say
    // what the template cannot: what the job actually is, and what to bring.
    //
    // Two things the template says that these deliberately DO NOT repeat:
    //   - the "reply PT/ES/EN to change language" line. We already know this
    //     person's language — it is why this string is being read from this
    //     dictionary and not another one. Telling someone how to pick the
    //     language they are already reading is noise (issue #46, defect 3).
    //   - the "reply STOP to unsubscribe" line. STOP is still honoured by the
    //     webhook on every inbound message; it just does not need saying every
    //     single morning.
    /** Opens the free-form briefing. Followed by a blank line. */
    freeFormGreeting(name: string): string;
    /** The line introducing the day's list, e.g. "Hoje tens 2 tarefas:". */
    freeFormHeader(count: number): string;
    /** A task's own description, indented under its title. Kept as a separate
     *  key so a dictionary can add punctuation or an em-dash of its own. */
    freeFormDescription(text: string): string;
    /** The materials line under one task. `items` is already joined. */
    freeFormMaterials(items: string): string;
    /** Joins the material names inside that line. */
    freeFormMaterialSeparator: string;

    // ── what the briefing was still not saying (issue #49, complaint 1) ──────
    // #46 added the description and the materials. What a crew member still had
    // to phone somebody for was WHERE — `jobs.address`, appended to the
    // task_board view by 0027 and read by nothing that talks to them — and what
    // a task is waiting on, which is why "I turned up and the floor wasn't
    // ready" happens.
    //
    // Both are optional per task and both are omitted entirely when empty: an
    // empty "Morada: —" line is worse than no line.

    /** The site address line under one task. */
    freeFormAddress(text: string): string;
    /** What this task is waiting on. `items` is already joined and capped. */
    freeFormWaitingOn(items: string): string;
    /** A task the worker has already declared finished, awaiting the manager. */
    freeFormAwaitingReview: string;

    // ── the guided menu's task detail (issue #49, complaint 3) ───────────────
    /** Headline of one task's detail sheet. `title` already carries the obra. */
    detailHeader(title: string): string;
    /** Due date line, when the task has one. */
    detailDue(date: string): string;
    /** Shown when a task carries no description, materials or address at all. */
    detailNothingMore: string;
    /**
     * An overdue task on the guided menu's detail sheet.
     *
     * Separate from `taskOverdue` because it carries NO number of days: the
     * menu reads task_board through the worker projection, which does not
     * expose `days_overdue`, and inventing one is worse than omitting it. The
     * 07:00 briefing, which does have the number, still uses `taskOverdue`.
     */
    detailOverdue(title: string): string;

    // ── the language line (issue #49, complaint 2) ───────────────────────────
    /**
     * "Reply PT, ES or EN to change language."
     *
     * Federico's second complaint was that this sentence was on EVERY single
     * message. It was, because it lived in the approved Meta template body —
     * baked in, unconditional, and unreadable from here.
     *
     * It now lives in this string instead, appended to the template's own {{2}}
     * parameter, and the caller decides. See renderWorkerBriefing: it goes out
     * only to a crew member who has never chosen a language AND has never
     * written to us, which is as close to "first contact only" as the data
     * allows without a new column. Everyone else never sees it again.
     *
     * ⚠ NO TRAILING FULL STOP. This string is appended INSIDE {{2}}, and the
     * approved template body continues with its own sentence straight
     * afterwards ("… Responde STOP para deixar de receber."). A full stop here
     * renders as ".." in the message that actually goes out — visible only on
     * the live send, to a crew member, on their first ever contact.
     *
     * ⚠ The other half of that fix is NOT in this repo. The live
     * `capo_daily_briefing` template still carries the old sentence until it is
     * re-approved in WhatsApp Manager — see docs/whatsapp-cloud-api-runbook.md.
     */
    languageHint: string;

    // ── the crew day link (issue #114) ───────────────────────────────────────
    /**
     * The sentence above the URL of the crew day page (/dia).
     *
     * ⚠ NO TRAILING NEWLINE and NO URL in the string. The renderer puts the
     * link on its own line underneath, so that WhatsApp treats the whole line
     * as the tap target and draws a preview. A sentence with the URL inline
     * gets a smaller tap target on exactly the phones this is for.
     *
     * ⚠ FREE-FORM ONLY. `toTemplateParam` flattens all whitespace and
     * `capo_daily_briefing` is pinned to {{1}}/{{2}} with no button component,
     * so this can never ride the paid template — see WorkerFreeFormOptions.
     *
     * It says what is behind the link rather than "click here": the crew member
     * is deciding whether to open a browser while standing next to a van.
     */
    dayLinkCta: string;

    // ── the WELCOME message (issue #45) ──────────────────────────────────────
    // The first thing Capo ever says to somebody, sent once and never again,
    // and the only message in the product whose whole job is to explain what
    // the sender is.
    //
    // ⚠ IT IS NOT A REQUEST FOR CONSENT, AND MUST NEVER READ AS ONE. A
    // proactive WhatsApp message is legal only AFTER an opt-in is on record, so
    // by the time any of these strings is rendered the person has already
    // agreed (on site, to their manager, or by ticking the box on /perfil).
    // The welcome CONFIRMS that agreement and states how to withdraw it. Copy
    // that asked "do you want to receive messages?" would be asking a question
    // the answer to which is the reason the message was allowed to be sent.
    //
    // ── the template split, and why the interesting half is a PARAMETER ──────
    // The approved Meta template `capo_welcome` is
    //     "<fixed opening> {{1}}<fixed>. {{2}} <fixed closing>"
    // and the fixed parts cannot be changed from this repository — editing an
    // approved template means re-submitting it by hand and waiting for review.
    // That is exactly the trap the daily briefing fell into with its "reply PT,
    // ES or EN" line (issue #49). So everything audience-specific lives in
    // {{2}}: `welcomeWorker` and `welcomeManager` below. One approved template,
    // two very different messages, and the difference is ours to change.
    //
    // ⚠ BOTH ARE TEMPLATE PARAMETERS. One line each — no newlines, no tabs, no
    // runs of four spaces, or Meta rejects the whole send with a 132000.

    /**
     * {{2}} for a CREW MEMBER: their manager put their number in, this is what
     * they will now get, and how to change the language it arrives in.
     *
     * The language sentence is unconditional here and conditional in the daily
     * briefing, and that asymmetry is deliberate: a welcome is by definition
     * first contact, so this is the one message where "reply PT, ES or EN" is
     * certainly new information rather than daily noise.
     */
    welcomeWorker(company: string): string;
    /**
     * {{2}} for a MANAGER: their account is live, and this message is itself
     * the proof that the number they typed on /perfil actually reaches them.
     * No language sentence — a manager changes language on the profile screen.
     */
    welcomeManager(company: string): string;
    /**
     * The free-form opening, used ONLY when the recipient has written to us in
     * the last 23 hours and ordinary text is therefore allowed (and free).
     * Mirrors the approved template's fixed opening so the two envelopes say
     * the same thing.
     */
    welcomeGreeting(name: string): string;
    /**
     * The free-form closing, mirroring the template's own opt-out sentence.
     * Meta expects a utility message to state how to stop receiving them, and
     * the free-form path has no approved wrapper to state it for us.
     */
    welcomeStop: string;
    /**
     * The manager's CHAT-THREAD note: who Capo just introduced itself to.
     *
     * Same contract as `managerEvent` and `checkinEvent` — our copy, a count,
     * and crew names the MANAGER typed, joined and capped by the renderer.
     * Never a word a crew member wrote. Crew only: a manager reads their own
     * welcome on their own phone and does not need Capo telling them about it.
     */
    welcomeEvent(args: { notified: number; names: string }): string;
  };
}
