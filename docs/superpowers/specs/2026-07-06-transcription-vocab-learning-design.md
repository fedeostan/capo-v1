# Self-learning transcription vocabulary — design

**Date:** 2026-07-06
**Status:** approved by Federico (signal, extraction, lifecycle, and architecture chosen via Q&A)

## Problem

The EU-PT voice input steers Gemini with a static glossary plus live worker/obra names. Everything else — client names, street names, crew slang, materials — gets misheard until someone hand-edits the glossary. The system should learn from usage: every time the manager corrects a transcription before sending, that correction is a signal about vocabulary the transcriber gets wrong.

## Decisions (settled)

1. **Signal: corrections only.** The diff between what the transcribe route returned and what the manager actually sent. No frequency mining of message history.
2. **Extraction: LLM (haiku)** via a new `extraction` role in the model registry — handles multi-word names and distinguishes corrections from rephrasings. Not a deterministic word-diff.
3. **Lifecycle: auto with cap + reinforcement.** No review UI, no Capo tool. Terms carry a weight; re-corrections reinforce; the instruction injects only the top 40 by weight/recency, so wrong learnings sink naturally.
4. **Architecture: dedicated feedback route + `transcription_vocab` table.** Fully input-layer. The chat route, `core.ts`, capabilities roster, and the agent `memories` table are untouched (memories inject into Capo's system prompt each turn — wrong tier for transcription bias).

## Components

### Migration `supabase/migrations/0004_transcription_vocab.sql`

```sql
create table transcription_vocab (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  term text not null check (char_length(term) <= 40),
  weight int not null default 1,
  created_at timestamptz not null default now(),
  last_reinforced_at timestamptz not null default now()
);
create unique index transcription_vocab_company_term
  on transcription_vocab (company_id, lower(term));
alter table transcription_vocab enable row level security;
```

- Case-insensitive dedupe, original casing preserved (names need it).
- The 40-char CHECK is a structural bound: a learned "term" can never be a paragraph that hijacks the transcription instruction. Enforced by the DB, not a prompt.
- Deny-all RLS, service-role access only — house pattern.

### Registry role (`src/agent/models.ts`)

`extraction: () => anthropic('claude-haiku-4-5-20251001')` — same model as `summarizer` today, but its own role so swapping one never silently changes the other.

### Capture (`app/chat.tsx`, ~10 lines)

- A ref accumulates the text the mic inserted during the current composer session.
- On submit: if a transcript exists and the sent text differs from it, fire-and-forget `POST /api/transcribe/feedback` with `{ transcript, final }`; clear the ref either way.
- Unedited transcript → no request (nothing to learn). Feedback failure → silently ignored. Sending is never delayed.

### Feedback route (`app/api/transcribe/feedback/route.ts`, new)

- Validate: both strings non-empty, each ≤ 2000 chars → else 400.
- `generateObject` with `getModel('extraction')`, zod schema `z.array(z.string().max(40)).max(10)` — structural caps on count and length.
- Prompt (Federico's dial, `TODO(Federico)` with working baseline): compare heard vs sent; return ONLY proper names and domain terms that correct a mishearing; not rephrasings, not grammar edits; empty array when in doubt.
- Upsert per term against `(company_id, lower(term))`: existing → `weight + 1`, `last_reinforced_at = now()`, refresh stored casing; new → insert.
- Any extraction/DB failure → log, return 200 with `{ learned: 0 }`. Learning is best-effort by contract.

### Injection (`app/api/transcribe/route.ts`, edit)

- `fetchVocabulary` gains a third parallel query: top 40 terms by `weight desc, last_reinforced_at desc`.
- Instruction gains one line: "Termos e nomes que este encarregado costuma usar: …" — separate from the live worker/obra name lines, which stay as they are.

## Error handling

Every failure degrades to "no learning happened": vocab query failure at transcribe time already falls back to no hints; extraction failure stores nothing and still 200s; the client swallows feedback network errors. No path can affect recording, transcription, or sending.

## Testing

1. `tsc --noEmit`, `eslint`, `next build`.
2. Curl the feedback route with a known pair (transcript "para o José" / final "para o Zé, obra do Pingo Doce") → assert rows exist via SQL; repeat → assert `weight = 2`.
3. Re-run the synthesized pt-PT audio test (macOS `say -v Joana` → afconvert/ffmpeg → curl) and confirm transcription still works with vocab injected; ideally show a learned term influencing output.
4. Guard checks: 41-char term rejected by DB; >10 terms rejected by schema; feedback with equal strings never fires from the client.

## Out of scope

Review UI for learned terms, a Capo "forget word" capability, decay-by-age pruning (ordering + cap covers it at this scale), learning from typed-only messages.
