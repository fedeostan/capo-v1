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
    taskStatus: Record<'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled', string>;
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
    taskDetail: {
      /** Page title when the task cannot be named (metadata runs before the row loads). */
      fallbackTitle: string;
      backToTasks: string;
      assignee: string;
      /** An active worker with no phone gets no 07:00 SMS and no reminder. */
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
    noSmsWarning: string;
    receivesSms: string;
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

  // The two language dials, rendered as cards on /perfil.
  settings: {
    yourLanguage: string;
    yourLanguageHint: string;
    companyLanguage: string;
    companyLanguageHint: string;
    companyLanguageWarning: string;
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
  };
}
