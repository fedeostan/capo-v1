# Pricing memo — August 2026

*Written for issue #111. This memo argues for three decisions: the shape of
the price, the level of the price, and whether to offer annual billing. The
decisions are Federico's; the memo's job is to give one concrete
recommendation for each, with the reasoning shown, and to flag what becomes
impossible to undo once real customers have paid. Cost figures come from the
architecture review's section 4 (`docs/architecture-review-2026-08.md`,
merged as #110), which read them off the live database's own ledgers.*

---

## 1. What one company costs us to serve

The number #110 measured: **an engaged company costs roughly $3–6 a month in
metered costs** — the costs that grow with use. That splits into:

- **AI: $1–6/month**, depending almost entirely on how much the manager
  chats. Manager chat is 94% of all AI spend and is the only meter in the
  product with no cap on it.
- **WhatsApp: $0.50–2/month** at current crew sizes (about $0.03 per
  template message, one or two proactive sends per day per reachable crew
  member). A fully-consented five-person crew could reach a $5–7/month
  ceiling.
- **Stripe: about €0.93 per monthly charge** (Stripe is the company that
  processes the card payment; it takes 1.5% + €0.25 of each European charge).
- **Hosting: €0 extra per company.** The servers are two flat bills (about
  $45/month total at list price) that do not grow when a company joins.
  Today those flat bills are bigger than all the metered costs combined,
  which is normal at four active tenants and stops being true at around a
  dozen.

In plain terms: **the variable cost of serving one engaged company is 5–10%
of the €45 price.** *Gross margin* — the share of each euro of revenue left
after the direct cost of serving that customer — is above 90% on every
additional company. Price is therefore not constrained by cost in either
direction; the questions that remain are about fairness, simplicity, and
what the buyer will believe.

**The one cost risk worth respecting:** our costs scale with crew size and
with how much people talk to Capo, while €45 is flat. A 30-worker company
where everyone messages Capo daily would cost several times what a 3-worker
company does, and pay the same. No such company exists today — the busiest
tenant cost $3.96 in August — but the risk is the input to the shape
decision below, so it stays on the table.

---

## 2. Recommendation: price shape

**Keep one flat price, and add a fair-use ceiling: €45/month for companies
up to 15 crew members; above that, "fale connosco" (talk to us).**

The four shapes the issue laid out, and why this one wins:

| Shape | Verdict |
|---|---|
| Flat €45, any size | Simple, but leaves the large-crew risk completely open |
| Per active crew member | Matches costs — but prices on the wrong variable (see below) and punishes growth |
| Bands (up to 5 / up to 15 / more) | Fair, but real build work we should not do yet |
| **Flat with a fair-use ceiling** | **Recommended: all the simplicity, the risk fenced, nothing to build** |

The reasoning, honestly weighed:

**Per-crew-member pricing prices on the wrong variable.** It looks like it
matches our costs, but #110 shows it does not: the dominant cost is manager
chat (94% of AI spend), and there is one manager per company whether the
crew is 3 or 30. Crew size only drives the WhatsApp line, which is cents.
Per-seat pricing would also punish exactly the behaviour that makes Capo
sticky — every crew member added makes the morning briefing worth more —
and it turns the price into a moving number a builder cannot predict.
The industry-normal shape is not automatically our shape.

**Bands are the right long-term answer and the wrong August answer.** Bands
mean multiple Stripe *price objects* (a price object is Stripe's frozen
record of "this product at this amount" — see section 4), an upgrade path
when a company crosses a band, and a customer-portal configuration that
currently, deliberately, allows no plan switching. That is real build and
support work, spent on making a $5 cost line fairer. Premature at four
active tenants.

**The fair-use ceiling costs one sentence.** It is a line on the landing
page and in the terms — no code, no new Stripe objects, no portal changes.
It fences the only real risk (the 30-worker company) without giving up the
one-price simplicity that a builder can repeat to another builder. And it
postpones the bands decision honestly: when the first company approaches 15
crew members, that is the moment to design bands, with a real customer in
front of us instead of a hypothesis.

**Why 15:** the target market (see the go-to-market memo) is firms of 3–20
people. A ceiling at 15 covers nearly all of it, and a company above 15 is
genuinely a different cost profile and probably a different sales
conversation anyway. The exact number matters less than having one.

---

## 3. Recommendation: price level

**Keep €45/month. Do not change it before roughly the first 20 paying
customers have answered it with their behaviour.**

The anchors, as the issue asked for them:

**What a Portuguese small builder already pays for comparable things.** The
closest comparable is the *contabilista* (accountant) — a monthly
subscription to make an admin burden go away, bought by exactly this buyer.
Small Portuguese firms pay **€100–500/month** for one, with a typical small
company at €100–350/month ([Grupo Your](https://grupoyour.com/pt/blog/quanto-custa-contabilista-portugal-2026),
[Contabilidades.pt](https://www.contabilidades.pt/blog/quanto-custa-contabilidade-pequena-empresa.html),
[HVR](https://www.hvrbusinessconsulting.com/pt/blog/quanto-custa-contabilista-lisboa-2026)).
Against that anchor, €45 reads as cheap for something that also removes
admin. Invoicing software — the other subscription this buyer commonly has —
runs roughly €10–30/month (approximate, not researched in depth), so €45
sits above "just software" and well below "professional service", which is
about right for what Capo is.

**The one-hour-of-tradesman-time test.** Hired-out Portuguese tradesman
labour runs **€150–400 per day** in 2026
([Prummo](https://prummo.app/pt/guias/quanto-custa-um-pedreiro)), i.e.
roughly €19–50 per hour charged out. €45/month is therefore **one to two
hours of charged-out time, or about a quarter of one day rate**. The test
the issue set — "if Capo does not obviously save an hour a month, the price
is wrong regardless of what it costs us" — is passed with room to spare:
writing and chasing the crew's day and collecting what came back is
plausibly an hour or more per *week* of the manager's time. If the product
works at all, €45 is easy to justify; if it does not, no price is right.

**Is €45 actually too low?** Possibly — the anchors would support €59 or
€75. But the honest position is that we have no evidence yet from people
paying with their own money. The asymmetry decides it: **raising the price
later is easy** (a new Stripe price for new customers; existing customers
stay on €45, which they will experience as loyalty), while **lowering it
later means either refunding nobody and looking greedy, or repricing
everyone and admitting the number was invented**. So: hold €45, ask every
paying customer directly what they would have paid, and revisit at ~20
customers with real renewal behaviour in hand.

---

## 4. Recommendation: annual billing

**Not yet. Offer annual — at €450/year, i.e. two months free — only after
roughly ten customers have paid for at least three consecutive months.**

The trade, as the issue framed it: annual billing improves cash (a year up
front) and reduces *churn* (customers cancelling — an annual customer
decides once a year instead of twelve times). Against that, it creates the
refund conversation we currently never have: today, cancelling simply takes
effect at the end of the paid month, no refunds, no part-month maths. A
customer eight months into a prepaid year who wants out either gets a
refund (a policy and a process we do not have) or feels trapped (a
reputation cost in a market that runs on word of mouth).

At today's stage the trade is bad. The product changes weekly, the
first-week experience still needs a human (see the go-to-market memo), and
we have no evidence yet that month two retains. Selling a year of that
converts an honest churn signal — "this customer left, find out why" — into
a dispute. And mechanically, an annual price is just a second Stripe price
object: **cheap to add later, so nothing is lost by waiting.**

The trigger is deliberately concrete: ten customers, three paid months
each. At that point retention is a fact rather than a hope, and the two
free months become a reward for conviction instead of a discount on risk.

---

## 5. What becomes irreversible once sold

These are the decisions that harden the moment real customers pay. Listed
so nothing hardens by accident:

1. **The no-IVA price is already frozen — and the real decision it hides is
   still open.** The live €45 price was created with Stripe calculating no
   IVA (VAT, *Imposto sobre o Valor Acrescentado* — Portuguese sales tax,
   normally 23%) and collecting no NIF (the customer's tax number). That
   setting on a Stripe price is *immutable* — permanently uneditable — once
   the price has been used, which it has. Adding IVA later means creating a
   **new price object** and leaving existing subscribers on the old one.
   The open decision: **when IVA handling eventually arrives, is €45 the
   with-tax number or the without-tax number?** €45 + 23% IVA = €55.35 to
   the customer; €45 including IVA = €36.59 of actual revenue, an 18.7% cut.
   Every customer sold today at a flat "€45" makes the with-tax reading
   harder to escape. This should be decided before selling at any scale —
   it is a question for Federico and an accountant, and it is flagged here
   rather than answered.
2. **Every price a customer has paid becomes a floor for them.** Raising
   the list price later is fine; raising it on an existing subscriber is a
   cancellation letter. Assume anyone who pays €45 keeps €45 indefinitely
   (*grandfathering* — letting existing customers keep old terms), and
   count only new customers when modelling a higher price.
3. **The fair-use ceiling must exist in writing before the first customer
   it would apply to.** Telling a 25-person company "€45" and later
   inventing a ceiling under them is a broken promise; a sentence on the
   landing page today costs nothing and preserves the option forever.
4. **The refund posture hardens with the first annual sale.** Monthly with
   cancel-at-period-end needs no refund policy. The day annual is offered,
   a written refund rule must exist first — which is one more reason
   annual waits.

---

## 6. Open questions for Federico

Collected from this memo; the recommendations above state which assumption
was used where an answer was missing:

1. **When IVA handling arrives, is €45 with-tax or without-tax?** (Section
   5.1 — the memo assumes no position; this needs an accountant.)
2. **Is there a revenue or customer target, and by when?** The
   recommendations assume the goal for the next two quarters is *learning*
   (do people pay, stay, refer) rather than revenue. A hard revenue target
   would strengthen the case for €59+ and for annual billing sooner.
3. **Fair-use ceiling at 15 crew members — right number?** Federico knows
   the real distribution of Portuguese crew sizes better than any document.

## Where this lives (for reference, skippable)

- Cost figures: `docs/architecture-review-2026-08.md` section 4, from the
  `ai_usage` and `notification_log` ledgers priced by
  `packages/core/src/agent/pricing.ts`.
- The live price: `price_1U4J91LIxn6JugmnvZc5XN12` (€45/month EUR,
  `tax_behavior: 'unspecified'`) on Stripe account `acct_1TtrERLIxn6Jugmn`.
- The trial rule: `apps/web/lib/billing-trial.ts` (14 days, held in our
  database, handed to Stripe at checkout).
- The paying screen: `apps/web/app/(app)/subscricao/`.
