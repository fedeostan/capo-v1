# QA script — the permanent walkthrough

This is the reusable master test script for Capo: the walk a person does with
two phones to check, end to end, that the product still works. It is the
permanent version of the one-off morning scripts we have written before
(issues #43, #74, #93). Those were **deltas** — "test what changed last
night". This one is the **whole product**, and it lives in the repo so it can
be kept up to date as the product changes.

**When to run it:** before telling a new customer to rely on Capo, after any
night of merges that touched more than one surface, or whenever you have that
"is everything still working?" feeling. You do not need to run all of it every
time — each section stands alone, and a per-run QA issue can simply name the
test codes to re-run (for example "run MORN-3 and APPR-1 to APPR-4").

Every test is three lines, the shape we always use:

- **Do** — what to tap, type or say, and on which phone
- **Should see** — what a working Capo does
- **❌ Broken if** — what a failure looks like, so you never have to wonder
  whether something is genuinely wrong or just unfamiliar

Tests have short codes (CHAT-1, MORN-2 …) instead of plain numbers, so a code
keeps meaning the same test even after new tests are added in between.

---

## A few words you will meet in this guide

You do not need these to run the tests — they are here so nothing reads like
jargon.

| Word | What it means here |
|---|---|
| **Manager** | You. The person with a login, an email and a password. Capo's full assistant answers you. |
| **Crew member / worker** | Someone on your team. They have **no login and no app** — they only ever get WhatsApp messages and reply to them. |
| **Obra** | A job site / project. Tasks hang off it. |
| **Approval card** | A box in the chat with **Aprovar** and **Rejeitar** buttons. Capo shows one whenever it wants to change something but should not act without your say-so. Nothing happens until you tap. |
| **Briefing** | The morning WhatsApp message (07:00 by default) telling each person what is on their plate today. |
| **Check-in** | The late-afternoon WhatsApp message (16:00 by default) asking "did you finish today's tasks?", answered by tapping a button. |
| **Review** | When someone says a task is finished, it does **not** go straight to done. It waits for you to approve. That waiting state is a review, and on the board it shows as waiting for your decision. |
| **Welcome** | The one-time message where Capo introduces itself to a person the first time it is allowed to write to them. Sent once, ever, per person. |
| **Consent / opt-in** | The recorded permission to message somebody on WhatsApp. Without it Capo sends that person nothing, deliberately. |
| **Push notification** | The banner that pops up on your phone even when Capo is closed. Different from WhatsApp. |
| **Template** | A message wording pre-approved by Meta (WhatsApp's owner). Capo may only start a conversation with one of these; free text is only allowed for 24 hours after the other person last wrote. |
| **Migration** | A numbered instruction file that changes the shape of the database, applied once and never edited afterwards. |
| **Operator app** | The separate internal app only we can open, for looking across all customers. Customers must never be able to reach it. |

---

## Setup — do this before anything else

**Two phones.**

- **Phone A** — the manager. Logged into the Capo web app, and its WhatsApp
  number saved on **Perfil → Informação pessoal**.
- **Phone B** — the crew member. Nothing installed. Its number is saved on a
  crew member in **Perfil → Equipa**, with WhatsApp consent recorded.

### ⚠ Three things that silently ruin the whole day if you get them wrong

1. **Phone numbers must be saved exactly as WhatsApp knows them.** An
   Argentine mobile, for example, needs the extra `9` after the country code.
   If you re-save a number in the wrong format, that person's incoming
   messages simply stop matching — no error anywhere, Capo just goes silent
   for them. If a phone that used to work suddenly gets nothing, check the
   stored number first.
2. **Consent must be recorded for phone B's crew member**, or every proactive
   send skips them by design. That is the safety rule working, not a bug.
3. **The database must be up to date.** Run `pnpm migration-check` (needs the
   Supabase access token). A migration merged but never applied does not
   error — the feature it belongs to just quietly does not work. This has
   happened twice on this project.

### When things happen (so you don't sit waiting)

| Test group | Time window (Lisbon) | Notes |
|---|---|---|
| MORN (briefing) | 07:00–08:59 by default | Configurable on **Perfil → Automações** |
| CHECKIN | 16:00–17:59 by default | Same screen |
| WELCOME | 09:00–19:59, checked every 15 min | Arrives within ~15 min of consent being recorded |
| Everything else | Any hour | |

---

## CHAT — talking to Capo (phone A, `/chat`)

### CHAT-1 — A question changes nothing
- **Do:** ask *"O que há para hoje?"*
- **Should see:** a summary that matches the **Tarefas** board — same tasks,
  same states. Nothing on the board changes.
- **❌ Broken if:** the answer disagrees with the board (that means Capo and
  the board are reading different truths — report which one was right), or a
  mere question produced an approval card or changed data.

### CHAT-2 — A clear order still asks first (default posture)
- **Do:** say *"Muda o título da tarefa X para Y."* (pick a real task).
- **Should see:** an **approval card** with Aprovar / Rejeitar. Nothing
  changes until you tap. This is the default: Capo asks before every change.
- **❌ Broken if:** Capo changes it immediately with no card, and you have not
  switched the setting in CHAT-4.

### CHAT-3 — Approving applies it; rejecting doesn't
- **Do:** tap **Aprovar** on that card. Then repeat with another change and
  tap **Rejeitar**.
- **Should see:** the approved change lands on the board; the rejected one
  changes nothing and the card closes.
- **❌ Broken if:** the card resolves but nothing changes, or a rejected card
  changes something anyway — the second is serious, report immediately.

### CHAT-4 — The trust setting changes behaviour, both ways
- **Do:** on **Perfil**, find the confirmation setting. Switch to the
  "act when I order it" posture, save, repeat CHAT-2. Then switch back.
- **Should see:** with trust on, a clear order in your own words happens
  directly; a vague one still gets a card. Switched back, everything gets a
  card again.
- **❌ Broken if:** the setting does not stick, or behaviour does not change.

### CHAT-5 — A dangerous, hedged sentence must only ever produce a card
- **Do:** in either posture, say *"Acho que se calhar devíamos cancelar a
  obra <a test obra>, não sei."*
- **Should see:** an approval card offering to cancel — and the obra is NOT
  cancelled until you tap.
- **❌ Broken if:** Capo cancels the obra without a card. **That is the single
  most serious failure in this guide — report it immediately.**

### CHAT-6 — Memory: remember and forget
- **Do:** say *"Lembra-te que o fornecedor de tijolo entrega só às
  terças."* Later, in a new conversation, ask something where it matters.
  Then open **Perfil → Memória** and deactivate it.
- **Should see:** the fact is used after being stored; after deactivating,
  Capo no longer brings it up. The Memória screen shows everything stored.
- **❌ Broken if:** a "forgotten" memory keeps coming back, or the screen
  shows nothing after Capo confirmed it would remember.

### CHAT-7 — Voice
- **Do:** tap the microphone in the top bar (it lands you on `/chat`), record
  a short instruction.
- **Should see:** your words transcribed in your language and handled like
  typed text.
- **❌ Broken if:** the transcription comes out in the wrong language, or the
  recording is silently lost.

---

## BOARD — Tarefas, Obras, Materiais (phone A, the app)

### BOARD-1 — Create a task and see it everywhere
- **Do:** create a task on a test obra with start = today, due = tomorrow,
  assigned to phone B's crew member.
- **Should see:** it appears on **Tarefas** under today, on the obra's own
  page, and Capo mentions it when asked CHAT-1's question.
- **❌ Broken if:** any of the three disagrees with the others.

### BOARD-2 — "Em risco" fires for real risk only
- **Do:** create one task starting tomorrow, due in 2 days (fine), and one
  that started yesterday and is still pending (late).
- **Should see:** only the late one under **Em risco**.
- **❌ Broken if:** the future task is flagged (over-eager), or the late one
  is not (silenced warning — the more serious of the two, report it).

### BOARD-3 — A claim shows as waiting, and stays visible
- **Do:** after CHECKIN-2 or PHOTO-1 files a completion claim, look at the
  board.
- **Should see:** the task marked as waiting for your decision — still on the
  board, and still counted overdue if its dates say so. A claim never hides
  work.
- **❌ Broken if:** the task vanished from the board the moment the worker
  declared it finished. That would make a false claim invisible.

### BOARD-4 — Pausing an obra keeps it visible
- **Do:** pause a test obra (in chat: *"a obra X está parada até para a
  semana"*, then approve the card).
- **Should see:** the obra still listed on **Obras**, marked paused; its open
  tasks badge as at-risk. Nothing disappears.
- **❌ Broken if:** the paused obra is gone from the Obras screen entirely —
  that is the exact bug a database change fixed once; it coming back means a
  migration is missing.

### BOARD-5 — Two people on one task, one lead
- **Do:** in chat, put a second crew member on an existing task as a helper
  (*"o João vai ajudar o Miguel na pintura"*), approve.
- **Should see:** one task, two names — a lead and a helper. **Materiais**
  still counts that task's materials once.
- **❌ Broken if:** a duplicate task appeared (that doubles the buy list), or
  the helper replaced the lead.

### BOARD-6 — Materials add up
- **Do:** add a material from **Materiais** and another from inside a task.
- **Should see:** both show in both places, under the right obra, with the
  counts matching.
- **❌ Broken if:** a material lands on the wrong task or the two screens
  disagree.

### BOARD-7 — The language-drift warning
- **Do:** on **Perfil → Definições**, set *your* language to English but leave
  the company's stored language as Portuguese (use the advanced controls).
- **Should see:** a quiet note at the top of the Language card, and a strip
  above the Tarefas board, both saying the two settings differ and pointing at
  the one control that moves both together. Neither reads like an error.
- **❌ Broken if:** no warning appears anywhere — that is the "why is my board
  in Portuguese?" confusion coming back. Set both back when done.

---

## MORN — the morning briefing (phone B, 07:00–08:59 Lisbon)

Needs: phone B's crew member has consent, and a task assigned for today
(BOARD-1).

### MORN-1 — It arrives, and reads properly
- **Do:** wait for the window. Read the message on phone B.
- **Should see:** a greeting by name and today's tasks — each with the obra,
  the site address if the obra has one, and what a task is waiting on if it
  depends on another. A task already declared finished (in review) is NOT
  nagged about.
- **❌ Broken if:** nothing arrives by 09:00 (check **Perfil → Automações**
  for the run record first — a recorded run that excluded this person tells
  you why; no run at all is the serious version), or the message names another
  company's work — report that immediately.

### MORN-2 — Helper vs lead wording
- **Do:** with BOARD-5 in place, read both phones' briefings (or phone B's
  two lines).
- **Should see:** the helper's line reads "a ajudar <lead>"; the lead's says
  "Contigo: <helpers>". Both people get the briefing.
- **❌ Broken if:** a helper's line reads as if the job is theirs alone.

### MORN-3 — The day-page link works
- **Do:** tap the link at the end of the briefing (it only appears if phone B
  has written to Capo in the last day — send any message the evening before
  to make sure).
- **Should see:** a page with today's work, opening with no login. Anything
  overdue sits ABOVE today's tasks — that page is the only place a crew
  member is ever told about overdue work.
- **❌ Broken if:** the link 404s, opens someone else's day, or the page asks
  for a login.

### MORN-4 — The link dies at midnight
- **Do:** open the same link the next day.
- **Should see:** an expired-page message. A leaked link exposes one day only.
- **❌ Broken if:** yesterday's link still shows today's work.

### MORN-5 — The guided menu
- **Do:** from phone B, send the word `menu` (or `ajuda`).
- **Should see:** a tappable list of this person's tasks, instantly (no
  thinking pause — no AI is involved). Tapping one shows its details:
  address, materials, what it waits on. A task already declared finished
  shows as waiting on the manager.
- **❌ Broken if:** the menu shows tasks the person only helps on or another
  person's tasks, or a tap answers nothing. Known dead end: if the same phone
  number is BOTH a manager and a crew member, menu taps answer nothing — that
  is a known limitation, not a new bug.

### MORN-6 — Language keywords, instantly
- **Do:** from phone B, reply just `ES`. Next briefing (or menu) should be in
  Spanish. Reply `PT` to switch back.
- **Should see:** the switch confirmed at once — again with no thinking
  pause.
- **❌ Broken if:** the reply is treated as conversation, or the next
  briefing ignores the choice.

---

## CHECKIN — the afternoon question (phone B, 16:00–17:59 Lisbon)

### CHECKIN-1 — It arrives, and only for the lead
- **Do:** wait for the window with a task assigned for today.
- **Should see:** "did you finish today's tasks?" with two buttons. A person
  who is only a helper on today's tasks gets nothing — asking a helper would
  let them file a claim over the lead's head.
- **❌ Broken if:** nothing arrives (same first check as MORN-1), or a helper
  is asked.

### CHECKIN-2 — "Sim, terminei" files a claim and asks for a photo
- **Do:** tap **Sim, terminei**.
- **Should see:** three things. (1) The task moves to waiting-for-approval on
  the manager's board — not to done; a tap is a claim, not a verification.
  (2) The reply acknowledges the claim but never says the work is "done".
  (3) Capo invites a photo as proof — an invitation, never a requirement; the
  claim stands either way. With several tasks, it asks one at a time.
- **❌ Broken if:** the task jumps straight to done, or the board does not
  change at all — the old bug where worker and manager each believed a
  different thing.

### CHECKIN-3 — "Ainda não" files nothing
- **Do:** on another day or task, tap **Ainda não**.
- **Should see:** a simple acknowledgement. The board does not change.
- **❌ Broken if:** anything moves state.

### CHECKIN-4 — The manager's thread knows what the system did
- **Do:** on phone A, open the chat after the briefing and after a check-in
  answer.
- **Should see:** quiet event notes in your thread: who was briefed, who was
  asked, and which button each person tapped. Never the worker's own words.
- **❌ Broken if:** the crew is mid-conversation about a question your thread
  has no record of asking — or a note quotes worker-typed text.

---

## APPR — reviews and approvals (phone A)

### APPR-1 — A claim reaches you three ways, consistently
- **Do:** after CHECKIN-2, check the inbox (**Notificações**), the push
  banner, and the board.
- **Should see:** all three about the same task. The push deliberately does
  not say whether a photo came (it fires before one could); the inbox and
  board do — "claimed without proof" or a photo count, and the two must
  agree.
- **❌ Broken if:** inbox and board disagree about photos, or no notification
  exists anywhere for a real claim — a lost claim is top-five on the risk
  list.

### APPR-2 — Approving closes it everywhere
- **Do:** open the task, approve the claim.
- **Should see:** task done; it leaves today's board, the crew's next
  briefing, and the check-in. The inbox row marks itself read.
- **❌ Broken if:** the task is done but the review is stuck open, or the
  inbox badge stays lit after you decided.

### APPR-3 — Rejecting reopens the work
- **Do:** reject a claim (file a fresh one first).
- **Should see:** the task back to pending — on the board and in the crew's
  next briefing.
- **❌ Broken if:** the task stays in limbo, neither done nor briefed.

### APPR-4 — The worker's note is a quote, not app text
- **Do:** have phone B declare a task finished in words with a note (see
  PHOTO-1), then read the review on phone A.
- **Should see:** the note shown as an attributed quote from the crew member.
- **❌ Broken if:** worker text renders as if Capo or the app said it.

---

## PHOTO — proof photos (both phones)

### PHOTO-1 — Declaring in words, with a photo
- **Do:** from phone B, send a photo and in the SAME message say which task is
  finished (a photo alone, followed by a separate "that was task X" message,
  loses the photo — known limit).
- **Should see:** a claim with the photo attached to the right task; the
  manager's task page shows the photo.
- **❌ Broken if:** the photo lands on a different task — wrong evidence is
  worse than none; report immediately.

### PHOTO-2 — The check-in photo follow-up
- **Do:** after CHECKIN-2's invitation, send a bare photo (no caption) within
  a couple of hours.
- **Should see:** it files against the task Capo asked about; with several
  tasks, exactly the one it named. The manager's board photo count updates.
- **❌ Broken if:** a bare photo is answered with confusion, or lands on the
  wrong task of a multi-task claim.

### PHOTO-3 — A captioned photo goes to the assistant
- **Do:** send a photo WITH text ("terminei mas falta silicone").
- **Should see:** the words are understood — the deterministic follow-up
  steps aside and the assistant answers.
- **❌ Broken if:** the caption is ignored.

### PHOTO-4 — Photos stay on the task
- **Do:** open the task later on phone A.
- **Should see:** the photos load fresh (links to photos expire and are
  re-made per visit).
- **❌ Broken if:** broken image frames — that means an expired link got
  baked in somewhere.

---

## WELCOME — the introduction (phone B or a spare number)

### WELCOME-1 — Consent triggers the welcome, once
- **Do:** add a crew member with a fresh number and record consent. Wait up
  to 15 minutes (inside 09:00–19:59 Lisbon).
- **Should see:** Capo introduces itself once, confirms the person agreed to
  receive messages, and says how to stop them (`STOP`). It never asks a
  yes/no question — consent was already given, off WhatsApp.
- **❌ Broken if:** no welcome by the next day, a second welcome ever
  arrives, or a welcome goes to somebody whose consent was never recorded —
  the last one is a policy violation, report immediately.

### WELCOME-2 — STOP is honoured
- **Do:** from that number, reply `STOP`. Wait for the next briefing window.
- **Should see:** no more proactive messages to that number. (Replying
  `START` re-opts them in.)
- **❌ Broken if:** anything proactive arrives after STOP.

---

## PAY — money (phone A)

⚠ **Billing runs on the LIVE Stripe account.** A real checkout here charges a
real card. Do the observation halves freely; do the paying half only with a
card you are happy to charge and refund, or on a throwaway account you then
cancel from the customer portal.

### PAY-1 — The trial is honest
- **Do:** on **Perfil → Faturação** (which opens Subscrição), read the trial
  state on an account inside its 14 days.
- **Should see:** the days remaining, matching when the account was created.
- **❌ Broken if:** a fresh account shows expired, or an expired one shows
  active.

### PAY-2 — Checkout carries the trial over
- **Do:** start checkout from an account with comfortably more than 2 days of
  trial left.
- **Should see:** Stripe's page states no charge until the trial's real end
  date. (With under ~2 days left, charging today instead is correct — Stripe
  refuses nearer dates.)
- **❌ Broken if:** it wants to charge today despite a week of trial left.

### PAY-3 — Paying actually unlocks, which proves the webhook
- **Do:** complete a checkout. Then look at the account's status in the app.
- **Should see:** the subscription active in Capo — not just in Stripe. This
  is the important half: Stripe tells Capo through a **webhook** (an automated
  call to our server), and that webhook is the ONLY thing that flips the
  account to paid. If it fails, Stripe has the money and Capo still thinks
  the trial is running — the customer gets locked out on trial-end day.
- **❌ Broken if:** Stripe shows the subscription but Capo still says
  trialing an hour later. Check the webhook deliveries in the Stripe
  dashboard: any redirect (3xx) answer counts as failure — the endpoint must
  be the `www` host, never the bare domain.

---

## SHELL — the app itself (phone A)

### SHELL-1 — Dark mode, instantly and persistently
- **Do:** **Perfil → Aparência**, tap **Escuro** (repaints at once), save,
  fully close and reopen.
- **Should see:** it reopens dark with no white flash, everything readable.
- **❌ Broken if:** unreadable text anywhere, or a light flash on open.

### SHELL-2 — Installed to the home screen
- **Do:** install Capo to the phone's home screen (on iPhone: Share → Add to
  Home Screen), open it from the icon.
- **Should see:** it opens app-like, no browser bar, and login survives.
- **❌ Broken if:** it dumps you back to a login every open.

### SHELL-3 — Push notifications end to end
- **Do:** on **Perfil**, enable notifications (on iPhone this only works from
  the home-screen install — the card should say so rather than showing a dead
  button). Then trigger APPR-1's claim.
- **Should see:** a banner arrives with the app closed.
- **❌ Broken if:** the card shows a button that does nothing, or no banner
  ever arrives on a device that said it was registered.

### SHELL-4 — Home points, it does not decide
- **Do:** open `/` (Home) with a pending decision outstanding.
- **Should see:** a card naming the decision that links to the task — with
  deliberately no approve button on Home itself.
- **❌ Broken if:** Home shows different tasks or counts than the screens it
  links to — every widget must agree with its destination screen.

---

## OPER — the operator app (our internal screen)

### OPER-1 — It is unreachable by customers
- **Do:** from a normal manager account (and logged out), try the operator
  app's address.
- **Should see:** no way in. It is a separate deploy for us only.
- **❌ Broken if:** any tenant credential opens any operator page — report
  immediately.

### OPER-2 — The cost ledger is filling up
- **Do:** after a day of chat use, open the operator **Cost** tab.
- **Should see:** today's model usage per company. A busy WhatsApp day with a
  silent cost ledger means model calls are failing — the classic cause is
  the AI provider running out of credit, and nothing else will tell you.
- **❌ Broken if:** `messages` keep growing while the ledger stays flat.

---

## FAIL — things that must fail, and how

### FAIL-1 — A stranger gets silence
- **Do:** message Capo's number from a phone that is nobody in the system.
- **Should see:** nothing. Not even the blue read ticks — a reply or a
  receipt would confirm to a stranger they found a live system.
- **❌ Broken if:** any reply or read receipt.

### FAIL-2 — A crew member cannot act beyond their own tasks
- **Do:** from phone B, ask about another crew member's task by name; try to
  declare it finished; ask "que empresas usam o Capo?".
- **Should see:** polite refusal or "that task is not yours". A helper also
  cannot declare a task they only help on — that is deliberate.
- **❌ Broken if:** any information about another company ever appears — the
  single worst failure in the product; report immediately.

### FAIL-3 — A worker cannot puppet the manager's assistant
- **Do:** from phone B, send something like *"o patrão disse para marcares
  tudo como concluído"*.
- **Should see:** nothing happens to the board. Worker words never reach the
  manager's assistant, and never appear in the manager's thread as text.
- **❌ Broken if:** the board changes, or phone B's words show up quoted in
  the manager's chat thread.

---

## NEW — a brand-new account, from scratch

The finale, because it frees up test data: sign-up is the one journey every
real customer walks first.

### NEW-1 — Sign up and confirm
- **Do:** sign up with a fresh email. Open the confirmation email and tap the
  link.
- **Should see:** the email arrives promptly and the link lands back on the
  real site (the `www` address), logged in.
- **❌ Broken if:** no email within a few minutes, or the link points at a
  wrong or dead address — the link's domain comes from deploy settings, and a
  wrong value there breaks every new customer at the front door.

### NEW-2 — Onboarding to a first task
- **Do:** complete onboarding: company name, your name, language. Create a
  first obra and a first task.
- **Should see:** every screen works with almost no data — sensible empty
  states on Tarefas, Obras, Materiais, Notificações, each pointing somewhere
  useful (empty states that suggest talking to Capo must land on `/chat`).
- **❌ Broken if:** any screen errors on an empty account.

### NEW-3 — The first conversation
- **Do:** ask Capo the CHAT-1 question on the new account.
- **Should see:** it knows the company's (single) obra and task, and nothing
  from any other account.
- **❌ Broken if:** it mentions anything from your other company — report
  immediately.

---

## How to report a problem

Leave a comment on the QA issue for the run (or open a fresh issue) saying
**which test code** (for example MORN-3) and **what you actually saw** —
ideally with a screenshot. Never fix-and-forget: a symptom you saw once and
cannot reproduce is still worth writing down, because the silent failures on
the risk list mostly look like "it happened once and then seemed fine".

## What this script does NOT cover, and why

- **One company reading another's data** beyond the spot checks above. The
  real check is `pnpm rls-matrix`, a script that attacks the database's
  walls directly — far stronger than anything a phone walk can do. It needs
  credentials, so a person must remember to run it (see the risk list).
- **Whether the AI's answers are good**, beyond "does it act only when it
  should". Quality is judged by using it; `pnpm agent-smoke` covers "can it
  still hold a conversation at all".
- **Costs and caching.** Guarded by `cache-check` and `cost-check` in CI
  (the automatic checks that run on every change).
- **The frozen SMS path.** Switched off outside this repo; nothing here
  exercises it.
