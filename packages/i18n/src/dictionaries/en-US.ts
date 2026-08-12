import type { Catalog } from '../catalog';

// American English. Register mirrors the pt-PT original: jobsite, direct,
// contractions throughout — never project-management SaaS.
const dict: Catalog = {
  meta: {
    htmlLang: 'en-US',
    dateLocale: 'en-US',
    appName: 'Capo',
    appDescription: 'Your virtual foreman',
    languageName: 'English',
    titleSuffix: 'Capo',
  },

  nav: { chat: 'Chat', tasks: 'Tasks', jobs: 'Jobs', materials: 'Materials', profile: 'Profile' },

  common: {
    signOut: 'Sign out',
    save: 'Save',
    backToLogin: 'Back to sign in',
    notAuthenticated: 'Not authenticated',
  },

  pullToRefresh: { refreshing: 'Refreshing…' },

  chat: {
    title: 'Capo 👷',
    tagline: 'Your virtual foreman',
    placeholder: 'Type, talk, or paste the quote…',
    send: 'Send',
    typing: 'Capo is typing…',
    stop: 'Stop',
    errorTitle: "Capo couldn't reply.",
    errorHints: {
      billing: 'Your subscription has expired. Go to Subscription to reactivate it.',
      auth: 'Your session ended. Sign in again.',
      network: 'No connection. Check the network and try again.',
      generic: "Could have been the network or a momentary glitch. Your message wasn't lost.",
    },
    retry: 'Try again',
    dismiss: 'Dismiss',
    emptyThread: 'Talk to Capo — he handles the jobs, the tasks, and the crew.',
    proposalTitle: 'Capo proposes',
    pendingProposals: 'Waiting on you',
    approve: 'Approve',
    reject: 'Reject',
    deciding: 'Applying…',
    cardState: {
      approved: '✅ Approved — done',
      rejected: '❌ Rejected',
      failed: '⚠️ Approved, but it failed to run',
      not_pending: 'This proposal was already resolved',
      error: '⚠️ Error resolving the proposal',
    },
    toolLabels: {
      create_task: 'Task created',
      update_task: 'Task updated',
      list_tasks: 'Tasks looked up',
      agenda: 'Schedule checked',
      materials_outlook: 'Materials checked',
      create_job: 'Job created',
      update_job: 'Job updated',
      list_jobs: 'Jobs looked up',
      add_worker: 'Worker added',
      update_worker: 'Worker updated',
      list_workers: 'Crew looked up',
      remember: 'Noted',
      search_knowledge: 'Knowledge base searched',
      set_language: 'Language changed',
      translate_company_data: 'Translation proposed',
      propose: 'Proposal created',
      generate_plan: 'Plan generated',
    },
  },

  mic: {
    record: 'Record a voice message',
    stop: 'Stop recording',
    noAccess: 'No microphone access',
    notUnderstood: "Didn't catch that — try again",
    error: 'Transcription failed',
  },

  dashboard: {
    taskStatus: {
      pending: 'Pending',
      in_progress: 'In progress',
      pending_review: 'Awaiting review',
      blocked: 'Blocked',
      done: 'Done',
      cancelled: 'Cancelled',
    },
    overdueBy: days => (days === 1 ? '1 day past due' : `${days} days past due`),
    noAssignee: 'Unassigned',
    assignedTo: name => `Assigned to ${name}`,
    noJob: 'No job',
    noDate: 'No date',
    talkToCapo: 'Talk to Capo',
    dueBy: shortDate => `due ${shortDate}`,
    risk: {
      blocked: 'blocked',
      lateStart: 'should have started already',
      dueSoon: 'due within 2 working days',
      lateDependency: titles => `waiting on: ${titles.join(', ')}`,
      pausedJob: 'job paused',
    },
    progress: (done, total, pct) => `${done} of ${total} done (${pct}%)`,
    tasksDone: (done, total) => `${done} of ${total} tasks done`,
    noTasksRegistered: 'no tasks yet',
    overdueCount: n => `${n} overdue`,
    pendingCount: n => `${n} pending`,
    dependsOn: titles => `⤷ after: ${titles.join(', ')}`,
  },

  notifications: {
    title: 'Notifications',
    subtitle: 'What happened since you last looked.',
    empty: 'Nothing unread. When a worker declares a task finished, it shows up here.',
    banner: n => `${n} ${n === 1 ? 'update' : 'updates'}`,
    markAllRead: 'Mark all as read',
    failed: 'Could not mark as read.',
    unread: 'Unread',
    profileLink: 'Notifications',
    kind: {
      review_pending: subject => `“${subject}” is waiting for your review.`,
    },
    noSubject: 'A task',
    noteLabel: 'What they wrote:',
    openSubject: 'Open in tasks',
    pushNudge: 'Want these on your phone?',
    pushNudgeLink: 'Turn on alerts',
  },

  push: {
    title: 'Phone alerts',
    subtitle: 'Get an alert the moment someone says a task is finished — even with the app closed.',
    enable: 'Get alerts',
    enabled: 'Alerts are on for this phone.',
    disable: 'Turn off',
    working: 'One moment…',
    failed: "Couldn't change your alerts. Try again.",
    deniedTitle: 'You blocked alerts on this phone.',
    deniedHelp: "To get them again you'll have to allow them in your phone's settings — Capo can't ask a second time.",
    iosTitle: 'On iPhone, only with Capo installed.',
    iosHelp: 'iPhone alerts only work with Capo on your home screen.',
    iosLink: 'See how to install it',
  },

  screens: {
    tasks: {
      title: 'Tasks',
      quando: {
        hoje: 'Today',
        amanha: 'Tomorrow',
        atrasadas: 'Overdue',
        risco: 'At risk',
        todas: 'All',
      },
      empty: {
        hoje: 'Nothing scheduled for today.',
        amanha: 'Nothing scheduled for tomorrow.',
        atrasadas: 'Nothing past due. Good sign.',
        risco: 'Nothing at risk right now.',
        todas: 'No open tasks.',
      },
      emptyForDate: 'Nothing scheduled for that day.',
      emptyFallback: 'No tasks.',
      emptyInJob: base => `${base.replace(/\.$/, '')} on this job.`,
      count: n => `${n} ${n === 1 ? 'task' : 'tasks'}`,
      filterByJob: 'Filter by job',
      filterByDay: 'Filter by day',
      allJobs: 'All jobs',
      jobStatusSuffix: { paused: ' (paused)', done: ' (done)' },
    },
    jobs: { title: 'Jobs', subtitle: 'Active jobs — progress and delays', empty: 'No active jobs.' },
    jobDetail: {
      fallbackTitle: 'Job',
      empty: 'No tasks on this job yet — ask Capo to build the plan.',
    },
    taskActions: { complete: 'Complete', reopen: 'Reopen', failed: "That didn't work, try again." },
    taskReview: {
      declaredBy: name => `${name} says this is done:`,
      declaredByManager: 'Awaiting review:',
      declaredByUnknownWorker: 'A worker says this is done:',
      approve: 'Approve',
      reject: 'Reject',
      dismiss: 'No check needed',
      request: 'Request review',
      failed: 'Could not resolve the review',
    },
    taskDetail: {
      fallbackTitle: 'Task',
      backToTasks: '← Tasks',
      assignee: 'Assignee',
      assigneeNoPhone: 'no phone on record',
      assigneeInactive: 'inactive',
      dates: 'Dates',
      startDate: 'Start',
      dueDate: 'Due',
      durationDays: days => `${days} working ${days === 1 ? 'day' : 'days'}`,
      description: 'Description',
      noDescription: 'No description. Ask Capo to add what the worker needs to know.',
      materials: 'Materials',
      job: 'Job',
      help: 'Help',
      askCapo: 'Ask Capo about this task',
      askCapoPrompt: title => `Tell me about the task "${title}".`,
      knowledge: 'What the rules say',
      knowledgeHint: 'Laws, regulations and technical datasheets related to this task.',
    },
    taskPhotos: {
      sheetTitle: 'Photos of the work',
      sheetIntro: 'Show what got finished — the finished detail, not the whole site.',
      addPhotos: 'Add photos',
      preparing: 'Preparing the photos…',
      limitHint: (max, megabytes) => `Up to ${max} photos, ${megabytes} MB each.`,
      remove: 'Remove photo',
      confirm: n => (n === 1 ? 'Complete with 1 photo' : `Complete with ${n} photos`),
      skip: 'Complete without photos',
      cancel: 'Cancel',
      sending: 'Sending…',
      sectionTitle: 'Photos',
      sourceWorker: 'from the worker',
      sourceManager: 'yours',
      errors: {
        mime: 'Photographs only (JPG, PNG or WEBP).',
        too_large: 'That photo is too big.',
        empty: 'Pick at least one photo, or tap “Complete without photos”.',
        too_many: 'That is too many photos at once.',
        unknown_task: 'That task no longer exists.',
        upload_failed: "The photos didn't upload. Try again.",
        generic: "That didn't work, try again.",
      },
    },
    taskHelp: {
      title: 'Help',
      intro:
        "Excerpts from the shared knowledge base, found from this task's title and description. Always confirm at the source before you decide.",
      empty:
        'Nothing found about this task. That does not mean it does not exist — it means it is not in the knowledge base.',
      failed: 'Could not reach the knowledge base right now.',
      backToTask: '← Back to task',
      category: {
        lei: 'Law',
        regulamento: 'Regulation',
        tecnica: 'Technique',
        material: 'Material',
        fabricante: 'Manufacturer',
      },
    },
    materials: {
      title: 'Materials',
      subtitle: 'What has to be on site',
      tomorrow: 'For tomorrow',
      week: 'Rest of the week',
      weekHint: 'Order these now — anything with a lead time will not wait.',
      emptyTomorrow:
        'Nothing to confirm for tomorrow. If there is work scheduled with no materials recorded, ask Capo what is missing.',
      forTasks: tasks => `for: ${tasks.join(', ')}`,
      pending: n => `${n} ${n === 1 ? 'material' : 'materials'} for tomorrow`,
      pendingHint: 'Check it is on site before you finish for the day.',
    },
  },

  auth: {
    login: {
      title: 'Capo',
      email: 'Email',
      emailPlaceholder: 'you@company.com',
      password: 'Password',
      submit: 'Sign in',
      google: 'Sign in with Google',
      forgot: 'Forgot your password?',
      createAccount: 'Create account',
      errors: {
        credenciais: 'Wrong email or password. Check them and try again.',
        'link-invalido': 'That link expired or was already used. Request a new one.',
      },
    },
    signup: {
      title: 'Create account',
      subtitle: '14 days free. No credit card.',
      submit: 'Create account',
      checkEmailTitle: 'Confirm your email',
      checkEmailText: "We sent you a confirmation link — open it to get started.",
      alreadyConfirmed: 'Already confirmed? Sign in here',
      haveAccount: 'Already have an account?',
      signIn: 'Sign in here',
      errors: {
        dados: 'Enter a valid email and a password of at least 8 characters.',
        fechado: 'Sign-ups open soon — ask for an invite.',
      },
    },
    recover: {
      title: 'Reset password',
      subtitle: "Give us your email and we'll send you a link.",
      submit: 'Send link',
      sentTitle: 'Check your email',
      sentText: "If an account exists for that email, we've sent a link to reset the password.",
      errors: { dados: 'Enter a valid email.' },
    },
    newPassword: {
      title: 'New password',
      label: 'New password',
      errors: {
        curta: 'The password must be at least 8 characters.',
        guardar: "Couldn't save that. Request a new reset link.",
      },
    },
  },

  onboarding: {
    title: 'Welcome to Capo',
    subtitle: 'Just a few details to get started: your company, your phone, and your language.',
    companyName: 'Company name',
    companyPlaceholder: 'Smith Construction LLC',
    yourName: 'Your name',
    yourNamePlaceholder: 'John Smith',
    phone: 'Your mobile',
    phonePlaceholder: '+1 555 123 4567',
    phoneHint: 'This is how you can talk to Capo on WhatsApp, without opening the app.',
    language: 'Language',
    languageHint: 'You can change this later — just tell Capo.',
    submit: 'Get started',
    errors: {
      dados: 'Fill in the company name and your name.',
      telemovel: 'Invalid number. Use the full international format, e.g. +1 555 123 4567.',
      'telemovel-usado': "That number is already linked to another account.",
      guardar: "Couldn't save that. Try again.",
    },
  },

  profile: {
    title: 'Profile',
    company: 'Company',
    yourAccount: 'Your account',
    team: 'Crew',
    teamEmpty: 'Nobody on the crew yet.',
    teamEmptyCta: 'Ask Capo to add someone',
    noContact: 'No contact',
    inactive: 'inactive',
    workerLoad: (today, tomorrow, open) => `Today ${today} · Tomorrow ${tomorrow} · ${open} open`,
    noWhatsAppWarning: 'No phone number — gets nothing from the 07:00 WhatsApp.',
    noConsentWarning: "No consent on record — ask if they're happy to receive messages, then tell Capo.",
    receivesWhatsApp: 'gets the 07:00 WhatsApp',
    teamHint: 'To add or change someone,',
    teamHintLink: 'talk to Capo',
    subscription: 'Subscription',
    manageSubscription: 'Manage subscription',
    app: 'App',
    install: 'Install on your phone',
    companyNameLabel: 'Company name',
    fullNameLabel: 'Your name',
    phoneLabel: 'Your mobile',
    errors: {
      companyName: 'The company name must be between 1 and 120 characters.',
      fullName: 'Your name must be between 1 and 120 characters.',
      phone: 'Invalid number. Use the full international format, e.g. +15551234567.',
      phoneTaken: 'That number is already linked to another account.',
      save: "Couldn't save that. Try again.",
    },
  },

  settings: {
    language: 'Language',
    languageHint:
      "The language Capo speaks to you in, the language of this app, and the language the whole company's tasks, jobs, and notes are written in.",
    translateExisting: p => {
      const parts: string[] = [];
      if (p.tasks) parts.push(`${p.tasks} task${p.tasks === 1 ? '' : 's'}`);
      if (p.jobs) parts.push(`${p.jobs} job${p.jobs === 1 ? '' : 's'}`);
      if (p.workers) parts.push(`${p.workers} trade${p.workers === 1 ? '' : 's'}`);
      if (p.memories) parts.push(`${p.memories} note${p.memories === 1 ? '' : 's'}`);
      const last = parts.pop();
      if (!last) return 'Also translate what already exists';
      const list = parts.length > 0 ? `${parts.join(', ')} and ${last}` : last;
      return `Also translate what already exists (${list})`;
    },
    translateNothing: "There's nothing stored to translate yet.",
    translateWarning:
      "The crew's morning WhatsApp briefing will switch to the new language too, and materials will be grouped by their translated names. You can undo this for 30 days.",

    advanced: 'Advanced settings',
    advancedHint:
      "Use different languages for yourself and for the company's data — useful if you speak a different language from the rest of the crew.",
    yourLanguage: 'Your language',
    yourLanguageHint: 'The language Capo speaks to you in, and the language of this app. Affects only you.',
    companyLanguage: 'Company data language',
    companyLanguageHint:
      'The language Capo writes tasks, jobs, and notes in — what the whole crew sees on the dashboard.',
    companyLanguageWarning: 'Heads up: changed here, tasks and jobs that already exist are not translated.',
    appearance: 'Appearance',
    appearanceHint: "Light, dark, or whatever your phone's set to. Saved on this device only.",
    themeOption: { light: 'Light', dark: 'Dark', system: 'System' },
    whatsappConsent: 'WhatsApp messages',
    whatsappConsentHint:
      "The morning summary and the late-afternoon check, sent to your number. You can turn it off whenever you like.",
    whatsappConsentOption: { yes: 'Yes, send them', no: 'No thanks' },
    whatsappConsentOn: "You're receiving the daily messages.",
    whatsappConsentOff: "You're not receiving anything — turn it on here to start.",

    translationRunning: p => `Translating… ${p.done} of ${p.total}`,
    translationDone: n => `${n} field${n === 1 ? '' : 's'} translated.`,
    translationFailed: 'The translation stopped partway. Nothing was lost — you can pick it back up.',
    translationResume: 'Resume translation',
    revert: 'Undo translation',
    revertHint: days => `Restores the original wording exactly as it was, word for word. Available for ${days} days.`,
    reverted: 'Translation undone.',
    revertFailed: "Couldn't undo that. Try again.",

    saved: 'Saved.',
    failed: "Couldn't save that. Try again.",
  },

  billing: {
    title: 'Subscription',
    activated: 'Subscription active. Thanks!',
    unavailable: 'Billing is not available yet.',
    trialDaysLeft: days => `${days} days left in your free trial`,
    trialEnded: 'Trial period ended',
    statusLabel: {
      active: 'Subscription active',
      past_due: 'Payment overdue',
      canceled: 'Subscription cancelled',
    },
    price: '€45/month · no card to start · no per-worker cost',
    manage: 'Manage subscription',
    subscribe: 'Subscribe — €45/month',
    bannerBlocked:
      'Your subscription expired — WhatsApp still works, but the chat here and any actions are blocked. Tap to reactivate.',
    bannerTrial: days => `${days} days left in your free trial — tap to subscribe.`,
    bannerTrialEnded: 'Your trial ended — tap to subscribe.',
    blockedError: 'Your subscription expired. Go to Subscription to reactivate — WhatsApp keeps working.',
    checkoutFailed: "Couldn't start checkout.",
    noSubscription: "You don't have a subscription linked yet.",
  },

  install: {
    title: 'Install Capo',
    subtitle: 'With Capo on your home screen, you open the app in one tap — just like WhatsApp.',
    alreadyInstalled: 'Capo is already installed on this device. 💪',
    open: 'Open Capo',
    installButton: 'Install app',
    skip: 'Continue without installing',
    iosStep1Before: 'Tap',
    iosStep1Share: 'Share',
    iosStep1After: "in Safari's toolbar.",
    iosStep2Before: 'Choose',
    iosStep2Action: 'Add to Home Screen',
    iosStep3Before: 'Tap',
    iosStep3Action: 'Add',
    iosStep3After: 'Capo lands on your home screen like an app.',
    genericStep1Before: "Open the browser menu",
    genericStep2Before: 'Choose',
    genericStep2Action: 'Install app',
    genericStep2After: '(or “Add to Home screen”).',
  },

  landing: {
    metaTitle: 'Capo — The assistant that runs your WhatsApp',
    metaDescription:
      "The AI assistant that runs your WhatsApp and handles the jobsite paperwork. Send the quote, Capo builds the day-by-day plan, the crew gets its briefing every morning.",
    ogDescription:
      'Send the quote, Capo builds the day-by-day plan and briefs the crew every morning. €45/month, 14 days free.',
    headline: 'The assistant that runs your WhatsApp and handles the jobsite paperwork',
    subhead:
      "It's not construction management software. It's the virtual foreman who talks to you on WhatsApp, organizes the crew, and never forgets what's left.",
    ctaPrimary: 'Start free — 14 days',
    ctaSecondary: 'I have an account — Sign in',
    stepLabel: n => `Step ${n}`,
    steps: [
      {
        title: 'Send the quote',
        text: "Paste the quote or describe the job in a message — the way you'd tell a foreman.",
      },
      {
        title: 'Capo builds the day-by-day plan',
        text: 'Task sequence, dates, and materials, ready for you to approve on a card.',
      },
      {
        title: 'The crew gets its morning briefing',
        text: "Every worker gets the day's tasks on WhatsApp — no apps, no accounts.",
      },
    ],
    materialsTitle: 'Materials ahead of time',
    materialsText:
      "Capo tells the crew in advance what materials they'll need tomorrow — no more finding out on the day that something's missing.",
    priceSuffix: '/month',
    priceNote: '14 days free · no card · no per-worker cost',
    ctaFooter: 'Start free',
    signIn: 'Sign in',
  },

  offline: {
    title: 'No connection',
    text: 'Capo needs internet to show current data. Check your connection and try again.',
  },

  whatsapp: {
    voiceNoteFailed: "Couldn't play that voice note, boss. Can you resend it or type it out?",
    voiceNoteEmpty: "Got the voice note but couldn't make anything out. Can you say that again?",
    approveButton: 'Approve',
    rejectButton: 'Reject',
    approvalPrompt: 'Approve this one, boss?',
    proposalApproved: '✅ Done, boss.',
    proposalRejected: '❌ Alright, leaving it.',
    proposalFailed: reason => `⚠️ You approved it, but it failed to run: ${reason}`,
    proposalNotPending: 'That one was already decided.',
    proposalError: "I couldn't record that decision. Do it in the app.",
    approvalFallback: "I couldn't show the buttons. Approve or reject it in the app.",
    workerAck: 'Got it, thanks. Any questions, talk to your foreman. To change language reply PT, ES or EN.',
    workerLanguageChanged: "Done — I'll write to you in English from now on.",
    workerOptedOut: "You're unsubscribed — I won't message you again. Reply START if you change your mind.",
    workerOptedIn: "Great, you'll get the daily messages again. Reply STOP whenever you want to stop.",
    workerBudgetReached: "I can't answer any more messages today. I'll be back to normal tomorrow morning — if it's urgent, talk to your supervisor.",
    workerAgentFailed: "I can't answer right now. Try again in a bit, or talk to your supervisor.",
    workerPhotoFailed: "I couldn't get that photo. Can you send it again?",
    checkinDoneButton: 'Yes, all done',
    checkinNotDoneButton: 'Not yet',
    checkinDone: 'Nice one, thanks. Logged as finished for today.',
    checkinNotDone: 'Alright, thanks for letting me know. Logged.',
    checkinError: "I couldn't record your answer. Talk to your foreman.",
  },

  reminders: {
    templateLanguage: 'en_US',
    taskSeparator: ' · ',
    taskWithJob: (title, job) => `${title} (${job})`,
    taskOverdue: (title, days) => `${title} — ${days}d overdue`,
    andMore: n => `+${n}`,
    workerNothing: 'Nothing scheduled for today.',
    managerSummary: ({ today, unassigned, overdue }) => {
      const parts = [`${today} ${today === 1 ? 'task' : 'tasks'} for today`];
      if (unassigned > 0) parts.push(`${unassigned} unassigned`);
      if (overdue > 0) parts.push(`${overdue} overdue`);
      return parts.join(' · ');
    },
    managerNothing: 'Nothing scheduled for today.',
    managerEvent: ({ today, unassigned, overdue, notified }) => {
      const parts = [`Morning. ${today} ${today === 1 ? 'task' : 'tasks'} in progress today`];
      if (overdue > 0) parts.push(`${overdue} overdue`);
      if (unassigned > 0) parts.push(`${unassigned} unassigned`);
      const head = parts.join(' · ');
      const tail =
        notified === 0
          ? "I didn't message the crew."
          : `I sent the rundown to ${notified} ${notified === 1 ? 'person' : 'people'}.`;
      return `${head}. ${tail}`;
    },
  },
};

export default dict;
