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

  nav: { chat: string; tasks: string; jobs: string; materials: string; profile: string };

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
    kind: Record<'review_pending', (subject: string) => string>;
    /** Stand-in when the row carries no title — an unnamed task. */
    noSubject: string;
    /** Label above the worker's quoted note. Sits ABOVE it and is never
     *  merged into it: same attribution rule as the review control, because
     *  it is the same worker-authored text. */
    noteLabel: string;
    /** Sends the manager where the decision actually gets made — the board,
     *  not the inbox. */
    openSubject: string;
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
    jobDetail: { fallbackTitle: string; empty: string };
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
    };
    taskDetail: {
      /** Page title when the task cannot be named (metadata runs before the row loads). */
      fallbackTitle: string;
      backToTasks: string;
      assignee: string;
      /** An active worker with no phone gets no 07:00 WhatsApp briefing. */
      assigneeNoPhone: string;
      assigneeInactive: string;
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

  auth: {
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
      checkEmailTitle: string;
      checkEmailText: string;
      alreadyConfirmed: string;
      haveAccount: string;
      signIn: string;
      errors: Record<'dados' | 'fechado', string>;
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
    // Keys must match Theme in apps/web/lib/theme.ts — tsc catches drift at
    // the call site, where the index is typed as Theme. Duplicated rather than
    // imported: @capo/i18n is a zero-dependency leaf and must never reach into
    // an app. Same pattern as billing.statusLabel below.
    themeOption: Record<'light' | 'dark' | 'system', string>;

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
     * Sent to a WORKER who replies to their briefing. Workers have no account
     * and no conversation with Capo — this ack exists so the reply is not met
     * with silence, and it carries the language hint because replying a
     * keyword is the only control a worker has.
     */
    workerAck: string;
    /** Sent after a worker switches language — always in the NEW language. */
    workerLanguageChanged: string;

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
    /** Sent after a worker taps "done". */
    checkinDone: string;
    /** Sent after a worker taps "not yet". Never scolding — the answer is
     *  useful precisely because it is safe to give. */
    checkinNotDone: string;
    /** The worker_checkins write failed. Silence after a tap reads as "Capo is
     *  broken", the same failure mode proposalError guards against. */
    checkinError: string;
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
    /** A worker with nothing scheduled today. */
    workerNothing: string;
    /** The manager's one-line WhatsApp summary. */
    managerSummary(counts: { today: number; unassigned: number; overdue: number }): string;
    /** The manager's line when the company has nothing on today. */
    managerNothing: string;
    /** The fuller version written into the chat thread, where newlines are fine. */
    managerEvent(counts: { today: number; unassigned: number; overdue: number; notified: number }): string;
  };
}
