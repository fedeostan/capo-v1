# Go-to-market memo — August 2026

*Written for issue #111. This memo answers four questions: who exactly we
sell to, the one sentence that says what Capo is, which channels to try
first (ranked by what they cost to try), and what must be true before
spending a single euro on acquiring customers — with an honest audit of
which of those things exist today, checked against the repository rather
than against memory. Where only Federico can answer, the assumption used is
stated and the question is collected at the end.*

---

## 1. Who exactly

**Small Portuguese building firms, roughly 3–20 people, where one person is
both running the sites and doing the admin, and the crew is already
coordinated over WhatsApp.**

Every clause is doing work:

- **Small (3–20)** — below 3 there is nothing to coordinate; above ~20
  there is usually an office person, and Capo's pitch ("you are the office")
  stops landing. This also matches the pricing memo's fair-use ceiling.
- **One person running sites AND admin** — this is the buyer. The person
  who answers the phone on a scaffold and does the paperwork at the kitchen
  table at night. Capo sells them their evening back.
- **Crew already on WhatsApp** — the clause that matters most, because it
  is the wedge: **the crew installs nothing.** Every competitor asks the
  workers to adopt an app; the workers do not adopt apps. Capo arrives
  inside the app they already open every morning. A firm whose crew is not
  on WhatsApp is not a lead, whatever its size.
- **Portuguese** — an assumption, stated: this memo plans for **Portugal
  only** to start. The product speaks Portuguese, Spanish and English, so
  the constraint is sales and support capacity, not code. Spain doubles the
  market and doubles the support surface; that is Federico's call (open
  question 1).

The buyer and the user are different people, and the sale is to the buyer:
the manager pays €45 and gets the relief; the crew just gets a clearer
morning message. Marketing that talks to workers is wasted.

## 2. The one sentence

The issue's own draft is the right one, and this memo recommends adopting
it as-is:

> **"Your crew already gets their day over WhatsApp. Capo is what writes
> it, chases it, and tells you what came back."**

In Portuguese, for the landing page and every flyer:

> **"A tua equipa já recebe o dia pelo WhatsApp. O Capo é quem o escreve,
> quem o acompanha, e quem te diz o que voltou."**

Why this sentence and not a grander one: it starts from a fact the builder
already knows is true about their own crew (instant recognition), it never
says "software", "platform" or "AI" (words that mean "another thing to
learn"), and each verb maps to a real feature — *writes it* (the 07:00
briefing), *chases it* (the afternoon check-in), *tells you what came back*
(completion claims, photos, the manager's approval). The sentence makes no
promise the product cannot keep.

## 3. Channels, ranked by cost-to-try

Ranked by what it costs to *try* the channel — money and Federico's hours —
not by eventual size. The principle: this buyer does not read LinkedIn, does
not attend webinars, and does not search for "construction management
software". They trust other builders, their accountant, and the counter at
the builders' merchant.

| # | Channel | Cost to try | The move |
|---|---|---|---|
| 1 | **Word of mouth from the pilot** | Free | Ask the pilot manager for two introductions to builders they know. One referred builder is worth more than any campaign. |
| 2 | **Accountants who serve builders** | Free to try | The *contabilista* already bills this exact buyer €100+/month (pricing memo, section 3) and is their most trusted admin advisor. Pitch five accountants on "your builder clients stop losing hours to WhatsApp chaos"; offer a referral arrangement. One accountant can carry ten clients. |
| 3 | **Builders' merchants and trade suppliers** | Tens of euros | The crew is physically at the *balcão* (trade counter) every morning. A flyer with a QR code at three local merchants, with the counter staff briefed in one sentence. Cheap, regional, and reaches the buyer in a buying frame of mind. |
| 4 | **Regional word of mouth, deliberately worked** | Federico's time | Pick ONE region and saturate it: every referral, merchant and accountant in one district, so builders hear the name twice from different mouths. A name heard twice is a thing that exists. |
| 5 | **Trade associations** (AICCOPN, AECOPS) | Membership fees, slow | Newsletters and events reach the right firms but slowly and formally. Worth joining for legitimacy once there are references to point at; not a first euro. |
| — | **LinkedIn, generic online ads** | — | Not for this buyer. Ruled out in the issue and this memo agrees. The one online exception worth testing *later*: Google search ads on high-intent Portuguese queries (a builder typing a problem into Google), only after the landing page carries proof. |

**The proof requirement sits above all channels.** Nothing on this list
converts without a real foreman saying it worked. The single highest-value
marketing asset available today is turning the pilot tenant into a **named
reference** — company name, manager quote, one before/after ("Sundays: two
hours of planning → zero"). Whether the pilot would go on record is open
question 2, and answering it comes before spending on any channel.

## 4. The four preconditions — and what actually exists today

The issue's rule: four things must be true before spending a euro on
acquisition. Audited against the repository as of 2026-08-31:

| # | Precondition | Status |
|---|---|---|
| 1 | Landing page that survives a sceptic | **Exists, but would not yet survive one** |
| 2 | Working signup | **Fully built; live status unverified** |
| 3 | Trial that converts without a human | **Exists** |
| 4 | First-week experience that does not need Federico | **Does not exist yet** |

The honest detail on each:

**1. Landing page — exists, but thin.** `apps/web/app/(public)/landing/`
is a real, tasteful, three-language page: headline, three steps, the €45
price said plainly, sign-up buttons. What a sceptic notices in the first
ten seconds: **no proof** (no named customer, no quote, no numbers), no
screenshots of the product or of a real briefing message, and no answers to
the questions a sceptic asks (what happens to my data, what if the crew
ignores it, how hard is it to leave). It is a fine page to send a warm
referral to; it is not yet a page to send paid traffic to. The fix is
mostly section 3's reference work, not code.

**2. Signup — built end-to-end in code, but the switch may be off.** This
audit corrects the issue's assumption that signup is invite-only: since the
Phase 4 auth work, the full self-serve chain exists in the repository —
`/registar` (sign-up page) → confirmation email → `/onboarding` (company
creation) → trial starts automatically. But two things live outside the
code, in the Supabase dashboard (Supabase is the service hosting our
database and logins), and `docs/human-todo.md` §2 does not record either as
done: the **"Allow new users to sign up" switch** (until it is on, every
signup attempt sees "Os registos abrem em breve" — by design), and
**production email sending** (the default sender is rate-limited and not
meant for real volume — meaning confirmation emails could silently stop
arriving under load). Verifying the switch, configuring the email sender,
and walking the whole flow once on a real phone is an afternoon — and it is
a hard precondition (open question 3).

**3. Trial — exists and is structural.** Fourteen days, started
automatically the day the company is created, held in our own database, and
handed to Stripe at checkout (`apps/web/lib/billing-trial.ts`). When the
trial expires without payment, the app locks; paying is a normal Stripe
checkout. No human needs to touch any of it. This is the strongest of the
four.

**4. First week — the real gap.** What happens automatically today is
genuinely good: Capo introduces itself to each crew member over WhatsApp
once consent is recorded, the 07:00 briefing and afternoon check-in start
on their own, and completion claims flow back. But between signup and that
steady state sits a stretch that today assumes Federico is watching: the
manager must add each worker *and* record their WhatsApp consent with no
in-app guidance on why or how; phone-number formats have known sharp edges
(an Argentine number stored without its extra 9 silently breaks inbound
messages — `docs/whatsapp-cloud-api-runbook.md`); the knowledge base is
loaded by an operator, not by the customer; and nothing in the product
notices a stranded new company (signed up, added nobody, heard nothing) —
today Federico notices. A stranger who signs up from an ad would quite
possibly stall in week one and cancel, and the product would never know
why. **This is the precondition to build next**, and it is product work: a
first-run checklist in the app, consent explained where the worker is
added, and an alert when a new company goes quiet.

**Bottom line: spend nothing on acquisition yet.** The order of work that
falls out: (a) verify the signup switch and email sender — an afternoon;
(b) get the pilot on record and put that proof on the landing page; (c)
build the first-week experience; *then* start at channel 1 and work down
the list. Channels 1 and 2 can be *warmed* (conversations, not spend)
while (b) and (c) are in progress, because a warm referral tolerates a
manual first week in a way an anonymous signup does not.

## 5. Open questions for Federico

1. **Portugal only, or Portugal + Spain?** This memo assumes
   Portugal-only for the first phase; the product itself would not need to
   change.
2. **Will the pilot company go on record as a named reference,** with a
   quote and a repeatable before/after? If yes, that is the first marketing
   task; if no, the first task is finding the customer who will.
3. **Is the Supabase "allow signups" switch on, and is production email
   sending configured?** Only the dashboard can answer
   (`docs/human-todo.md` §2). Until verified, every acquisition plan is
   theoretical.
4. **Is there a customer-number target and a date?** Section 3 assumes
   the next quarter is for learning (a handful of referred customers who
   talk to us), not volume. A volume target would reorder the channel list
   toward paid search sooner.

## Where this lives (for reference, skippable)

- Landing page: `apps/web/app/(public)/landing/page.tsx`; copy in
  `packages/i18n` (pt-PT / es-ES / en-US).
- Signup chain: `apps/web/app/(public)/registar/` →
  `/auth/confirm` → `apps/web/app/(public)/onboarding/`; dashboard steps in
  `docs/auth-onboarding-runbook.md` and `docs/human-todo.md` §2.
- Trial: `apps/web/lib/billing-trial.ts`; paying screen
  `apps/web/app/(app)/subscricao/`.
- The three proactive WhatsApp sends a new crew experiences: welcome
  (`apps/web/app/api/cron/welcome`), 07:00 briefing
  (`apps/web/app/api/cron/reminders`), afternoon check-in
  (`apps/web/app/api/cron/checkin`).
- Cost basis for channel economics: `docs/architecture-review-2026-08.md`
  section 4.
