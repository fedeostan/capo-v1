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

  nav: {
    home: 'Home',
    chat: 'Chat',
    tasks: 'Tasks',
    jobs: 'Jobs',
    materials: 'Materials',
    activity: 'Activity',
    profile: 'Profile',
  },

  shell: {
    openMenu: 'Open menu',
    profile: 'Profile',
    search: 'Search',
    searchUnavailable: 'Search is not available yet',
    voiceNote: 'Voice note',
    newTask: 'New task',
    close: 'Close',
    role: 'Site manager',
    version: (v: string) => `Capo ${v}`,
    rooms: {
      personal: { title: 'Personal information', sub: 'Company, name, email, phone' },
      team: { title: 'Team', sub: 'Who works with you' },
      billing: { title: 'Billing', sub: 'Subscription and payments' },
      privacy: { title: 'Privacy', sub: 'Memory, notifications, messages' },
      settings: { title: 'Settings', sub: 'Language, appearance, account' },
    },
    deleteAccount: {
      row: 'Delete account',
      cannotUndo: 'Cannot be undone',
      title: 'Delete this account',
      body: 'Every site, task, photo and message is deleted for the whole team. This cannot be undone.',
      placeholder: 'Company name',
      cancel: 'Cancel',
      confirm: 'Delete forever',
      unavailable: 'Deleting your account from the app is not available yet. Talk to us and we will take care of it.',
    },
  },

  activity: {
    title: 'Activity',
    subtitle: 'What happened on site',
    empty: 'Nothing has happened here yet.',
    today: 'Today',
    yesterday: 'Yesterday',
    claimed: (task: string, who: string) => `${who} says ${task} is finished.`,
    claimedAnon: (task: string) => `${task} was reported finished.`,
    approved: (task: string) => `You confirmed ${task}.`,
    rejected: (task: string) => `You sent ${task} back to be redone.`,
    photos: (count: number, task: string) =>
      count === 1 ? `1 photo added to ${task}.` : `${count} photos added to ${task}.`,
    checkinDone: (who: string) => `${who} answered that the day is done.`,
    checkinNotDone: (who: string) => `${who} answered that it is not finished yet.`,
  },

  home: {
    greetingMorning: (name: string) => (name ? `Good morning, ${name}` : 'Good morning'),
    greetingAfternoon: (name: string) => (name ? `Good afternoon, ${name}` : 'Good afternoon'),
    greetingEvening: (name: string) => (name ? `Good evening, ${name}` : 'Good evening'),
    summary: (sites: number, openTasks: number) =>
      `${sites === 1 ? '1 site active' : `${sites} sites active`} · ${openTasks === 1 ? '1 task open' : `${openTasks} tasks open`}`,
    nextUp: 'Next up today',
    allTasks: 'All tasks',
    nothingToday: 'Nothing scheduled for today.',
    decision: 'Needs your decision',
    decisionMore: (n: number) => (n === 1 ? '1 more waiting' : `${n} more waiting`),
    openTask: 'Open task',
    whatHappened: 'What just happened',
    seeActivity: 'Activity',
    crew: "Today's crew",
    checkedIn: (answered: number, total: number) => `${answered} of ${total} checked in`,
    silent: (n: number) => (n === 1 ? '1 silent' : `${n} silent`),
    noCrew: 'Nobody on the team yet.',
    materialsLow: 'Materials running low',
    allMaterials: 'All materials',
    materialsNone: 'Nothing needed for tomorrow.',
  },

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
    emptyThreadOnboarding: 'Say hello to Capo to start setting the company up.',
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
    agendaToday: 'Today',
    agendaTomorrow: 'Tomorrow',
    agendaOverdue: 'Overdue',
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
    jobPaused: 'Paused',
    jobPausedHint: 'No work booked for now. The tasks are still here.',
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
      worker_request: subject => `${subject} asked for something on site.`,
      review_no_photo: (subject, quote) =>
        quote
          ? `“${subject}” was declared finished with no photo. They said: “${quote}”`
          : `“${subject}” was declared finished with no photo.`,
    },
    noSubject: 'A task',
    noteLabel: 'What they wrote:',
    openSubject: 'Open in tasks',
    pushNudge: 'Want these on your phone?',
    pushNudgeLink: 'Turn on alerts',
  },

  requests: {
    title: 'Crew requests',
    seeAll: 'See all',
    more: n => `+${n} more`,
    category: {
      material: 'Material',
      tool: 'Tool',
      machine: 'Machine',
      delivery: 'Delivery',
      other: 'Other',
    },
    when: ({ kind, dateLabel }) => {
      if (kind === 'today') return 'for today';
      if (kind === 'tomorrow') return 'for tomorrow';
      if (kind === 'overdue') return dateLabel ? `was needed by ${dateLabel}` : 'the day has passed';
      if (kind === 'later') return dateLabel ? `for ${dateLabel}` : 'for later on';
      return 'no date given';
    },
    quoteLabel: name => `${name} wrote:`,
    whatsapp: ({ name, when, quote, task }) => {
      const where = task ? ` · ${task}` : '';
      return `Request from ${name}${where}, ${when}.\n\n“${quote}”\n\nIt is saved in your notifications. I have not ordered anything.`;
    },
    event: ({ name, when, task }) => {
      const where = task ? `, on the task “${task}”` : '';
      return `${name} asked for something over WhatsApp${where}, ${when}. It is in your notifications, in their own words.`;
    },
  },

  crewMessage: {
    whatsapp: ({ company, text }) =>
      `Message from ${company}:\n\n“${text}”\n\nYou can reply here and I will pass it back.`,
  },

  automations: {
    title: 'Automatic messages',
    subtitle: 'What Capo sends your crew on its own, at what time, and what happened each day.',
    profileLink: 'See automatic messages',
    costNote:
      'Every person who receives one of these counts as a paid WhatsApp send. A bigger crew, or more messages a day, means more cost.',

    job: {
      daily_briefing: {
        name: 'Morning message',
        what: "Tells each person what they have today: the job, the address, the materials and what it depends on.",
        who: 'Every active crew member with WhatsApp permission, and each manager on the account.',
      },
      task_checkin: {
        name: 'End-of-day question',
        what: 'Asks “did you finish today’s tasks?”, with two buttons to answer.',
        who: 'Only the person leading a task today. Someone who is only helping is not asked.',
      },
    },

    aimedAt: (hour: string) => `Aimed at ${hour}`,
    window: (from: string, to: string) => `Arrives between ${from} and ${to}`,
    nextRun: (when: string) => `Next: ${when}`,
    usingDefault: 'Using the built-in time — nobody has changed this one.',
    on: 'On',
    off: 'Off',
    enabledLabel: 'Send this message',
    hourLabel: 'Time',
    saved: 'Saved.',
    saveFailed: 'Could not save. Try again.',
    invalidHour: 'Pick a time between 05:00 and 21:00.',

    addTitle: 'Add another message',
    addExplanation:
      'You cannot create a new message from here yet, and the reason is on WhatsApp’s side: a message Capo sends without anyone having written first has to use wording Meta approved in advance. Wording you type would not go out. Until that exists, what you can do is change the time of these two, or switch off the one you do not want.',

    historyTitle: 'What happened',
    historyHint:
      'One line per day per message: the time it was due and the time it actually went out. The company that hosts Capo tends to knock late, so the two times are rarely the same.',
    historyEmpty: 'Nothing recorded yet.',
    due: 'Due',
    ran: 'Ran',
    lateBy: (minutesLabel: string) => `${minutesLabel} late`,
    onTime: 'On time',
    messagedCount: (n: number) => (n === 1 ? '1 person messaged' : `${n} people messaged`),
    failedCount: (n: number) => (n === 1 ? '1 failed' : `${n} failed`),
    skippedCount: (n: number) => (n === 1 ? '1 with nothing to say' : `${n} with nothing to say`),
    nothingSent: 'Nothing went out on this day.',

    debugTitle: 'Person by person',
    debugHint: 'Who got it, who did not, and why.',
    recipientWorker: 'Crew',
    recipientManager: 'Manager',
    outcome: {
      sent: 'Handed to Meta',
      delivered: 'Reached the phone',
      read: 'Read',
      failed: 'Failed',
      skipped: 'Not sent',
      pending: 'Unconfirmed',
    },
    outcomeHint: {
      sent: 'Meta accepted the message but has not confirmed it arrived.',
      delivered: 'Meta confirmed the message reached the phone.',
      read: 'The person opened it.',
      failed: 'Meta refused it or could not deliver it.',
      skipped: 'There was nothing to tell this person that day.',
      pending: 'The send started and never finished.',
    },

    reasonTitle: 'Who gets nothing, and why',
    reason: {
      noConsent: 'Has not given permission to receive WhatsApp.',
      unreachable: 'Has no number and no other way to be reached.',
      inactive: 'Is marked inactive on the crew.',
      managerNoConsent: 'The manager has not given permission to receive WhatsApp.',
      noManagerAccount: 'This company has no manager account at all, so the daily summary goes nowhere.',
    },
    reasonNamesHint:
      'The names below are from right now, not from the day in question — each day’s counts are kept, the names are not.',
    reasonNobody: 'Nobody is being left out.',

    metaError: {
      '132001': 'The approved wording does not exist in this language yet.',
      '131030': 'The number is not on the test list. This should no longer happen.',
      '131026': 'This number is not on WhatsApp.',
      '131047': 'More than 24 hours have passed since this person last wrote, so only approved wording can go out.',
      '131021': 'We tried to message our own number.',
      '132000': 'The text sent does not fit the approved format.',
    },
    metaErrorUnknown: 'Meta refused the send.',
    metaErrorLabel: (code: number) => `Code ${code}`,
  },

  memory: {
    title: 'Memory',
    subtitle: 'What Capo remembers about you and the company — and how to make it forget.',
    profileLink: 'See what Capo remembers',
    explainer:
      "Capo doesn't learn on its own: everything it knows from one conversation to the next is written down here, as separate sentences, and this is what it re-reads before every reply. If anything on this list is wrong or no longer true, delete it — it stops counting straight away.",

    companyHeading: 'About the company',
    companyHint: 'Everyone with an account at this company sees these.',
    personalHeading: 'About you',
    personalHint: 'Only you see these. Nobody else at the company can touch them.',
    empty: 'Nothing stored yet.',

    capTitle: 'What Capo carries',
    capHint: (carried: number, limit: number) =>
      `Capo carries the ${limit} most recent notes into each conversation. Right now it carries ${carried}.`,
    storedNotCarried: 'Stored, but outside the most recent — Capo is not reading this one.',

    forget: 'Forget',
    forgotten: 'Forgotten.',
    forgetFailed: "Couldn't delete that. Try again.",
    forgetNote:
      'Forgetting takes the note out of Capo\'s head for good. The record that it once existed is kept, in case you ever want to understand why it answered a certain way.',

    kind: {
      company: 'Company',
      job: 'Job',
      worker: 'Crew',
      preference: 'Preference',
      fact: 'Fact',
    },

    reviewTitle: 'The night review',
    lastReviewed: (when: string) => `Last reviewed: ${when}`,
    neverReviewed: 'No review has run yet.',
    reviewHint:
      'Every night, in the small hours, Capo re-reads your conversation and decides whether anything is worth keeping for three months from now. Most nights there is nothing, and that is normal.',
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
    jobs: { title: 'Jobs', subtitle: 'Progress, delays and paused jobs', empty: 'No jobs yet.' },
    jobDetail: {
      fallbackTitle: 'Job',
      empty: 'No tasks on this job yet — ask Capo to build the plan.',
      paused: 'This job is paused: no work is booked and nobody on the crew is asked about it. The tasks stay here until you restart it.',
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
      proofNone: 'No photos attached.',
      proofPhotos: n => (n === 1 ? '1 photo attached.' : `${n} photos attached.`),
      proofWaived: 'No photo. Capo asked twice, and one is still needed.',
      proofWaivedBadge: 'No photo',
    },
    taskDetail: {
      fallbackTitle: 'Task',
      backToTasks: '← Tasks',
      assignee: 'Assignee',
      assigneeNoPhone: 'no phone on record',
      assigneeInactive: 'inactive',
      assignUnassigned: 'Assign to…',
      assignTitle: 'Who does this task?',
      assignAvailabilityOn: shortDate => `Who is free on ${shortDate}`,
      assignAvailabilityUnknown:
        'This task has no dates, so there is no way to tell who is free.',
      assignFree: 'free',
      assignBusy: n => (n === 1 ? 'already has 1 task that day' : `already has ${n} tasks that day`),
      assignNoneFree: 'No workers are available for this task.',
      assignNoWorkers: 'No active workers on the team yet.',
      assignCurrent: 'current',
      assignRemove: 'Leave unassigned',
      assignCancel: 'Cancel',
      assignFailed: 'Could not change the assignee.',
      collaborators: 'Helping',
      collaboratorsNone: 'Only the assignee on this task.',
      collaboratorsTitle: 'Who else helps on this task?',
      collaboratorsHint:
        'The assignee does not change — these people work on the same task and get the morning message saying they are helping. The materials stay this task’s, they are not duplicated.',
      collaboratorsLead: 'assignee',
      collaboratorsSave: 'Save',
      collaboratorsFailed: 'Could not save who helps on this task.',
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
      // ── issue #154 ─────────────────────────────────────────────────────
      today: 'For today',
      todayHint: 'Mark what is already on site and what is missing. It starts again from scratch every morning.',
      emptyToday: 'No materials recorded for today’s work.',
      onSite: 'On site',
      missing: 'Missing',
      checkedCount: (onSite, total) => `${onSite} of ${total} on site`,
      checkFailed: 'That did not save. Try again.',
      tomorrow: 'For tomorrow',
      week: 'Rest of the week',
      weekHint: 'Order these now — anything with a lead time will not wait.',
      emptyTomorrow:
        'Nothing to confirm for tomorrow. If there is work scheduled with no materials recorded, ask Capo what is missing.',
      forTasks: tasks => `for: ${tasks.join(', ')}`,
      pending: n => `${n} ${n === 1 ? 'material' : 'materials'} for tomorrow`,
      pendingHint: 'Check it is on site before you finish for the day.',
    },
    // ── issue #60 ────────────────────────────────────────────────────────
    materialsEdit: {
      groupCount: n => (n === 1 ? '1 material' : `${n} materials`),
      groupEmpty: 'No materials recorded yet.',
      seeJob: 'Open job',
      add: 'Add material',
      edit: 'Edit materials',
      pickTask: 'Which task is it for?',
      pickTaskHint: 'Materials belong to a task. Pick the task this material is needed for.',
      taskCount: n => (n === 1 ? '1 material' : `${n} materials`),
      title: task => `Materials — ${task}`,
      placeholder: 'e.g. 20 bags of cement',
      addRow: 'Add a line',
      removeRow: 'Remove',
      empty: 'This task has no materials yet.',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      back: 'Back to tasks',
      failed: 'Could not save the materials.',
      noTasks: 'No task on this job can carry materials.',
    },
    // ── end issue #60 ────────────────────────────────────────────────────
  },

  auth: {
    showPassword: 'Show password',
    hidePassword: 'Hide password',
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
        'link-invalido':
          'That link expired or was already used. If your email is already confirmed, sign in with your password. If not, request a new one.',
      },
    },
    signup: {
      title: 'Create account',
      subtitle: '14 days free. No credit card.',
      submit: 'Create account',
      emailNote:
        'Next we send you an email with a link. You have to open it before the account works.',
      haveAccount: 'Already have an account?',
      signIn: 'Sign in here',
      errors: {
        dados: 'Enter a valid email and a password of at least 8 characters.',
      },
    },
    confirmEmail: {
      title: 'Confirm your email',
      sentTo: ({ email }) => `We sent an email to ${email}.`,
      sentToUnknown: 'We sent you an email with a confirmation link.',
      blockedNotice:
        "Your account exists, but it isn't confirmed yet — that's why your password wouldn't let you in.",
      step1: 'Open your inbox.',
      step2: "Look for the email from Capo. If it isn't there, check spam or promotions.",
      step3: 'Tap the link inside it.',
      thenWhat:
        'That link opens Capo with your account ready. You do not need to come back to this page.',
      resend: 'Resend the email',
      resent: 'We sent it again. It can take a minute to arrive.',
      wrongEmail: 'Wrong email? Create the account again',
      alreadyConfirmed: 'Already tapped the link? Sign in',
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
    emails: {
      languageLabel: 'English',
      confirm: {
        subject: 'Confirm your email · Capo',
        preview: 'One step left before your account is ready.',
        heading: 'Confirm your email',
        body: 'You created a Capo account. One step is left: tap the button to confirm this email is yours. After that your account is ready.',
        button: 'Confirm email',
        fallback:
          'The link can only be used once. If the button does not open, copy and paste this address into your browser:',
        otherLine:
          'You created a Capo account. Tap the button above to confirm your email and finish setting up.',
        footer:
          'You are getting this email because someone created a Capo account with this address. If it was not you, ignore this message: nothing happens.',
      },
      reset: {
        subject: 'Reset your password · Capo',
        preview: 'Choose a new password with the link inside.',
        heading: 'Reset password',
        body: 'You asked to reset the password on your Capo account. Tap the button to choose a new one.',
        button: 'Set a new password',
        fallback:
          'For safety, the link expires soon after it is sent and can only be used once. If the button does not open, copy and paste this address into your browser:',
        otherLine: 'You asked to reset your Capo password. Tap the button above to choose a new one.',
        footer: 'If you did not ask for this change, ignore this email: your password stays as it is.',
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
    phonePlaceholder: '555 123 4567',
    phoneHint: 'This is how you can talk to Capo on WhatsApp, without opening the app.',
    language: 'Language',
    languageHint: 'You can change this later — just tell Capo.',
    submit: 'Get started',
    errors: {
      dados: 'Fill in the company name and your name.',
      telemovel: 'Invalid number. Pick the country and type just the number, e.g. 555 123 4567.',
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
    awaitingFirstReply:
      "Gets the 07:00 WhatsApp, but has never written to Capo. Until they reply once, Capo can't answer them or send them their day.",
    awaitingFirstReplyChase: p =>
      `Consent on record for ${p.days} day${p.days === 1 ? '' : 's'} and still no reply to Capo. Until they write once, Capo can't answer them or send them their day. Worth asking them in person.`,
    firstReplyAction: 'Send them a message',
    firstReplyMessage: p =>
      `Hi ${p.name}. I've added you to Capo. It's what sends you the day's work on WhatsApp. Reply to it once, even just "yes": without that it can send you messages, but it can't answer you or send you your day.`,
    welcomeCostHint:
      'When you tell Capo that someone agrees to receive messages, Capo introduces itself to them once on WhatsApp. That is one paid message per person — a crew of 20 is 20 messages.',
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
      phone: 'Invalid number. Pick the country and type just the number, e.g. 555 123 4567.',
      phoneTaken: 'That number is already linked to another account.',
      save: "Couldn't save that. Try again.",
    },
  },

  report: {
    row: { title: 'Report a problem', sub: "Tell us what isn't working" },
    intro:
      "Tell us what went wrong, in your own words. It goes straight to the Capo team, along with the screen details — no need to explain where you were.",
    label: 'What happened?',
    placeholder: 'E.g.: the materials list shows the same tile twice',
    submit: 'Send',
    sent: "Got it, thanks. The Capo team will take a look.",
    empty: 'Write what happened first.',
    failed: "Couldn't log the report. Try again.",
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

    driftBanner: p => `Capo talks to you in ${p.you}, but writes tasks and jobs in ${p.board}.`,
    driftHint:
      "That makes sense when your crew reads a different language from you. If that's not your case, put both on the same language — Capo can translate what already exists.",
    driftAction: 'Put both on the same language',

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
    confirmPosture: 'Confirming changes',
    confirmPostureHint:
      'When you ask Capo to change something — create a task, hand it to someone else, cancel a job — it can check with you first or just go ahead.',
    confirmPostureOption: { always_ask: 'Always ask first', trust_quote: 'Go ahead' },
    confirmPostureOptionHint: {
      always_ask:
        'Safer. Every change shows up as a card with Approve and Reject first — nothing moves on the board until you tap. Costs you a tap each time.',
      trust_quote:
        'Faster. Capo acts straight away when it can quote your own words authorising the change; when it cannot, you still get the card.',
    },
    whatsappConsent: 'WhatsApp messages',
    whatsappConsentHint:
      "The morning summary and the late-afternoon check, sent to your number. You can turn it off whenever you like.",
    whatsappConsentOption: { yes: 'Yes, send them', no: 'No thanks' },
    whatsappConsentOn: "You're receiving the daily messages.",
    whatsappConsentOff: "You're not receiving anything — turn it on here to start.",
    whatsappConsentCost:
      'When you turn this on, Capo introduces itself once on your WhatsApp. That welcome is a paid message; the daily ones were already accounted for.',

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

  whatsappHandshake: {
    title: 'Talk to Capo on WhatsApp',
    subtitle: 'Capo works on WhatsApp, same as you and your crew. Send it the first message and it starts setting up your job.',
    prefill: 'Hi Capo! I just signed up. Can you help me get started?',
    openButton: 'Open WhatsApp',
    qrHint: 'Point your phone camera at the code.',
    webLink: 'Open in WhatsApp Web',
    consentLabel: 'Send me the day summary at 07:00 on WhatsApp',
    consentHint: 'You can turn this off any time, in your profile.',
    waiting: 'Waiting for your message…',
    arrived: 'Capo got your message. Check WhatsApp. ✅',
    stalled: phone => `Still nothing. Is ${phone} the number your WhatsApp runs on?`,
    fixNumber: 'Fix the number',
    skip: 'Do this later',
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
    turnFailed: "Sorry, boss — I couldn't answer that just now. Try again in a bit.",
    approveButton: 'Approve',
    rejectButton: 'Reject',
    approvalPrompt: 'Approve this one, boss?',
    proposalApproved: '✅ Done, boss.',
    proposalRejected: '❌ Alright, leaving it.',
    proposalFailed: reason => `⚠️ You approved it, but it failed to run: ${reason}`,
    proposalNotPending: 'That one was already decided.',
    proposalError: "I couldn't record that decision. Do it in the app.",
    approvalFallback: "I couldn't show the buttons. Approve or reject it in the app.",
    workerAck: 'Got it, thanks. Any questions, talk to your foreman.',
    workerLanguageChanged: "Done — I'll write to you in English from now on.",
    workerMenuButton: 'View task',
    workerMenuSection: 'Your tasks',
    workerMenuBody: (shown, total) =>
      shown < total
        ? `You have ${total} open tasks — here are the ${shown} closest. Pick one to see the details.`
        : total === 1
          ? 'You have 1 open task. Pick it to see the details.'
          : `You have ${total} open tasks. Pick one to see the details.`,
    workerMenuEmpty: "You don't have any open tasks right now. If you think you should, talk to your foreman.",
    workerMenuManagerRow: 'Talk to the boss',
    workerMenuManagerNote: "For anything I can't sort out from here",
    workerMenuManagerReply: "You'll want your foreman for that — from here I can only see your tasks and answer technical questions.",
    workerMenuUnknownTask: "I can't open that task any more. Reply HELP to see the list again.",
    workerOptedOut: "You're unsubscribed — I won't message you again. Reply START if you change your mind.",
    workerOptedIn: "Great, you'll get the daily messages again. Reply STOP whenever you want to stop.",
    workerBudgetReached: "I can't answer any more messages today. I'll be back to normal tomorrow morning — if it's urgent, talk to your supervisor.",
    workerAgentFailed: "I can't answer right now. Try again in a bit, or talk to your supervisor.",
    workerPhotoFailed: "I couldn't get that photo. Can you send it again?",
    checkinDoneButton: 'Yes, all done',
    checkinNotDoneButton: 'Not yet',
    checkinDone: 'Nice one, thanks. Logged as finished for today.',
    checkinDoneAwaiting:
      "Nice one, thanks. I've told your foreman — he still has to confirm it, so the task stays open until then.",
    checkinDoneNothing: 'Thanks, logged. There was nothing left waiting for approval.',
    checkinDoneProblem:
      "Your answer is logged, but I couldn't tell your foreman. Have a word with him.",
    checkinNotDone: 'Alright, thanks for letting me know. Logged.',
    checkinPhotoAsk: task =>
      `If you can, send me a photo of “${task}” and I'll attach it. If you can't, no problem — it's logged either way.`,
    checkinPhotoNext: task => `Got it, thanks. Any photo of “${task}”?`,
    checkinPhotoThanks:
      'Got it, thanks. It goes with the claim — your foreman still has to confirm it.',
    checkinError: "I couldn't record your answer. Talk to your foreman.",
    stillWorking: "Still working on this, boss — one more moment.",
    workerStillWorking: "Still looking into this — one more moment.",
    reportPrompt:
      "Tell me what's wrong with the app or my messages — your next message gets logged for the Capo team.",
    reportAck: 'Got it, thanks. Logged for the Capo team to look at.',
    reportFailed: "I couldn't log your report just now. Please try again in a bit.",
    workerAudioFailed: "I couldn't hear that voice note. Write it to me instead.",
    photoBatchAsk: count =>
      count === 1
        ? 'Got the photo. Any more, or is that everything?'
        : `I've got ${count} photos from you now. Any more, or is that everything?`,
    photoBatchMoreButton: 'More photos',
    photoBatchDoneButton: "That's everything",
    photoBatchMoreAck: 'Go ahead, send it.',
    photoBatchNone: "I haven't got any photos waiting from you. Send it and tell me which job it's of.",
    hiWorkerGreeting: name => `Hi ${name}! 👋`,
    hiWorkerWriteAnyTime: 'Write to me here whenever you need to, in português, español or English.',
    hiWorkerMorning: 'Every morning at 7am I send you your day here.',
    hiManager: appUrl =>
      `Hi! Talk to me here whenever you need to. Your sites and tasks are in the app: ${appUrl}`,
  },

  dia: {
    title: 'My day — Capo',
    dateLine: date => date,
    todayHeading: count => (count === 1 ? 'You have 1 task today' : `You have ${count} tasks today`),
    overdueHeading: count => (count === 1 ? 'Overdue (1)' : `Overdue (${count})`),
    nothing: 'Nothing scheduled for you today. Nice work.',
    askOnWhatsApp: 'Any questions? Reply to Capo on WhatsApp.',
    expiredTitle: 'This link has expired',
    expired:
      'Links last one day. You will get a fresh one on WhatsApp tomorrow morning, with an up-to-date list.',
  },
  reminders: {
    templateLanguage: 'en_US',
    taskSeparator: ' · ',
    taskWithJob: (title, job) => `${title} (${job})`,
    taskOverdue: (title, days) => `${title} — ${days}d overdue`,
    andMore: n => `+${n}`,
    // issue #44. The clause that stops a helper reading their briefing as if
    // the job were theirs. Applied before taskOverdue, so lateness stays last.
    taskAsCollaborator: (title, lead) => `${title} — helping ${lead}`,
    taskAsTeam: title => `${title} — as a team`,
    freeFormWith: names => `With you: ${names}`,
    workerNothing: 'Nothing scheduled for today.',
    // issue #108. The day's size and how to see it — never the squashed task
    // list. One line, no trailing full stop: the OLD template body continues
    // "…{{2}}. Reply STOP…" straight after it.
    workerKnock: ({ count, overdue }) => {
      const head = `${count} ${count === 1 ? 'task' : 'tasks'} today`;
      const late = overdue > 0 ? `, ${overdue} late` : '';
      return `${head}${late} — reply OK to see the details`;
    },
    managerSummary: ({ today, unassigned, overdue }) => {
      const parts = [`${today} ${today === 1 ? 'task' : 'tasks'} for today`];
      if (unassigned > 0) parts.push(`${unassigned} unassigned`);
      if (overdue > 0) parts.push(`${overdue} overdue`);
      return parts.join(' · ');
    },
    managerNothing: 'Nothing scheduled for today.',
    managerEvent: ({ today, unassigned, overdue, notified, names }) => {
      const parts = [`Morning. ${today} ${today === 1 ? 'task' : 'tasks'} in progress today`];
      if (overdue > 0) parts.push(`${overdue} overdue`);
      if (unassigned > 0) parts.push(`${unassigned} unassigned`);
      const head = parts.join(' · ');
      const who = names ? `: ${names}` : '';
      const tail =
        notified === 0
          ? "I didn't message the crew."
          : `I sent today's rundown to ${notified} ${notified === 1 ? 'person' : 'people'}${who}.`;
      return `${head}. ${tail}`;
    },
    checkinEvent: ({ asked, names }) => {
      if (asked === 0) return "Late this afternoon I couldn't ask anybody whether they had finished today's work.";
      const who = names ? `: ${names}` : '';
      return `Late this afternoon I asked ${asked} ${asked === 1 ? 'person' : 'people'} whether they had finished today's work${who}. Their answers show up here as they come in.`;
    },
    checkinAnswer: ({ name, answer, tasks }) => {
      const count = tasks > 0 ? ` (${tasks} ${tasks === 1 ? 'task' : 'tasks'})` : '';
      return answer === 'done'
        ? `${name} answered the check-in: says today's work is finished${count}. Waiting on you to confirm — it stays open on the board until you do.`
        : `${name} answered the check-in: not finished yet${count}.`;
    },
    nameSeparator: ', ',
    freeFormGreeting: name => `Morning, ${name}.`,
    freeFormHeader: count => `You have ${count} ${count === 1 ? 'task' : 'tasks'} today:`,
    freeFormDescription: text => text,
    freeFormMaterials: items => `Materials: ${items}`,
    freeFormMaterialSeparator: ', ',
    freeFormAddress: text => `Address: ${text}`,
    freeFormWaitingOn: items => `Waiting on: ${items}`,
    freeFormAwaitingReview: 'You already said this was finished — waiting on the boss to confirm.',
    detailHeader: title => `📋 ${title}`,
    detailDue: date => `Due: ${date}`,
    detailNothingMore: "I don't have any more detail on this one. Ask your foreman if you need it.",
    detailOverdue: title => `${title} — overdue`,
    languageHint: 'Reply PT, ES or EN to change language',
    dayLinkCta: '🔗 See your full list here:',
    welcomeWorker: ({ company, manager }) => {
      const added = manager
        ? `Your manager at ${company}, ${manager}, has just added you to Capo.`
        : `${company} has just added you to Capo.`;
      return `${added} Every morning I send you the day's tasks here; when you finish one, send me a photo; and if you run short of materials, ask me. Write PT, ES or EN to change language.`;
    },
    welcomeManager: company =>
      `Your ${company} account is ready: you get each morning's summary here, and you can talk to me on WhatsApp just as you do in the app.`,
    welcomeGreeting: name => `Hi ${name}, I am Capo, your site assistant.`,
    welcomeStop: 'Reply STOP to unsubscribe.',
    welcomeEvent: ({ notified, names }) => {
      const who = names ? `: ${names}` : '';
      return `I introduced myself on WhatsApp to ${notified} new ${notified === 1 ? 'person' : 'people'} on the team${who}.`;
    },
    welcomeButton: 'Say hi',
    assignmentGreeting: ({ name, count }) =>
      `Hi ${name}. Your boss just gave you ${count === 1 ? 'a new task' : `${count} new tasks`} for today.`,
    taskNewlyAssigned: title => `New: ${title}`,
  },

  phone: {
    country: 'Country',
    hint: 'Just the number, no country code.',
    countries: {
      PT: 'Portugal',
      ES: 'Spain',
      AR: 'Argentina',
      BR: 'Brazil',
      US: 'United States',
    },
  },
};

export default dict;
