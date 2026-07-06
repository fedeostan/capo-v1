-- Self-learning transcription vocabulary: terms the manager corrected in
-- voice transcriptions, reinforced on re-correction, injected (top-N) into
-- the transcription instruction. Input-layer data — NOT agent memory; the
-- memories table injects into Capo's system prompt, this never does.
create table transcription_vocab (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  -- 40-char cap is structural: a learned "term" can never be a paragraph
  -- that hijacks the transcription instruction.
  term text not null check (char_length(term) <= 40),
  weight int not null default 1,
  created_at timestamptz not null default now(),
  last_reinforced_at timestamptz not null default now()
);

-- Case-insensitive dedupe ("Zé" vs "zé"), original casing preserved.
create unique index transcription_vocab_company_term
  on transcription_vocab (company_id, lower(term));

-- Deny-all RLS, service-role access only (house pattern).
alter table transcription_vocab enable row level security;
