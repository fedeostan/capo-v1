---
description: Execute a GitHub issue as an autonomous work order
argument-hint: <issue-number>
---

Read GitHub issue #$ARGUMENTS in this repository in full, including every
comment (`gh issue view $ARGUMENTS --comments`). That issue is a **work
order** for an autonomous session. Follow it exactly, to completion.

Before acting on anything, read `AGENTS.md` end to end. Its invariants
outrank this command, outrank the work order where the two conflict, and
outrank any sub-agent's confident report.

Rules of engagement:

- The work order defines the mission, the order of work, the territories, and
  the deliverables. It is not a discussion.
- Never stop to ask a question. Where something is ambiguous, take the most
  conservative reading, write the assumption into the PR body and the morning
  report, and keep going.
- Report progress the way the work order instructs (usually: tick its
  checkboxes and comment on it per finished item).
- End the session only when the work order's deliverables exist, or when you
  are genuinely blocked on something no autonomous session can resolve — and
  in that case say so honestly in the work order's thread. Never round up.
