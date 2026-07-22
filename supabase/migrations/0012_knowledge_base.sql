-- Knowledge base: the shared Portuguese-construction corpus (laws, technical
-- guides, material/manufacturer docs) behind the agent's search_knowledge
-- tool. GLOBAL by design — no company_id: the corpus is operator-curated and
-- identical for every tenant, so RLS here is just "authenticated can read".
-- Writes happen exclusively through the service-role ingestion CLI
-- (scripts/knowledge-ingest.mts); there are no insert/update/delete policies.
--
-- First pgvector use in the project. memories (0001) stays vector-free on
-- purpose — knowledge is a separate retrieval system, not a memories upgrade.

-- Supabase convention: extensions live in the extensions schema, not public.
create extension if not exists vector with schema extensions;

-- ── documents ───────────────────────────────────────────────────────────────
-- One row per ingested source. source_ref (file path or URL) is the re-ingest
-- key: ingesting the same source again deletes the old row (cascading to its
-- chunks) and re-inserts — that is the law-update path.
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 300),
  source_type text not null check (source_type in ('pdf', 'url', 'markdown')),
  source_ref text not null unique,
  category text not null check (category in ('lei', 'regulamento', 'tecnica', 'material', 'fabricante')),
  -- Publication/consolidation date of the source itself (not ingestion time);
  -- lets the agent qualify how current a law citation is.
  published_at date,
  created_at timestamptz not null default now()
);

-- ── chunks ──────────────────────────────────────────────────────────────────
-- Heading-aware slices of a document (for laws: per Artigo). heading_path is
-- the human-readable breadcrumb ("RJUE > Artigo 6.º") the agent cites. Hybrid
-- retrieval needs both columns: embedding for paraphrase recall ("deitar
-- abaixo uma parede" → demolição), tsv for exact legal-term precision.
create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  chunk_index int not null,
  heading_path text not null default '',
  content text not null check (char_length(content) > 0),
  -- gemini-embedding-001 truncated to 1536 dims (HNSW indexes cap at 2000;
  -- cosine ranking is scale-invariant so the truncation needs no re-norm).
  embedding extensions.vector(1536) not null,
  tsv tsvector generated always as (to_tsvector('portuguese', content)) stored,
  metadata jsonb not null default '{}',
  unique (document_id, chunk_index)
);

create index knowledge_chunks_document_id_idx on knowledge_chunks (document_id);
create index knowledge_chunks_embedding_idx on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read-open to any signed-in tenant (the corpus is shared), write-closed to
-- everyone but the service role (which bypasses RLS).
alter table knowledge_documents enable row level security;
alter table knowledge_chunks enable row level security;

create policy knowledge_documents_select_all on knowledge_documents
  for select to authenticated using (true);
create policy knowledge_chunks_select_all on knowledge_chunks
  for select to authenticated using (true);

-- ── hybrid search ───────────────────────────────────────────────────────────
-- Reciprocal rank fusion over two independent rankings: cosine similarity on
-- embeddings and Portuguese full-text search. RRF (k=60) is rank-based, so
-- the two score scales never need calibrating against each other. security
-- invoker: callers only see what their SELECT policies allow (everything,
-- for authenticated — but the posture stays uniform with the rest of the DB).
create function search_knowledge(
  query_embedding extensions.vector(1536),
  query_text text,
  filter_category text default null,
  match_count int default 8
) returns table (
  chunk_id uuid,
  document_title text,
  category text,
  source_ref text,
  heading_path text,
  content text,
  score double precision
)
language sql stable
set search_path = ''
as $$
  with vec as (
    -- search_path is empty inside the function, so the cosine-distance
    -- operator must be schema-qualified via operator().
    select c.id, row_number() over (order by c.embedding operator(extensions.<=>) query_embedding) as rank
    from public.knowledge_chunks c
    join public.knowledge_documents d on d.id = c.document_id
    where filter_category is null or d.category = filter_category
    order by c.embedding operator(extensions.<=>) query_embedding
    limit least(match_count * 5, 50)
  ),
  fts as (
    select c.id, row_number() over (order by ts_rank(c.tsv, websearch_to_tsquery('portuguese', query_text)) desc) as rank
    from public.knowledge_chunks c
    join public.knowledge_documents d on d.id = c.document_id
    where c.tsv @@ websearch_to_tsquery('portuguese', query_text)
      and (filter_category is null or d.category = filter_category)
    limit least(match_count * 5, 50)
  ),
  fused as (
    select
      coalesce(vec.id, fts.id) as id,
      coalesce(1.0 / (60 + vec.rank), 0) + coalesce(1.0 / (60 + fts.rank), 0) as score
    from vec full outer join fts on vec.id = fts.id
  )
  select
    c.id as chunk_id,
    d.title as document_title,
    d.category,
    d.source_ref,
    c.heading_path,
    c.content,
    fused.score
  from fused
  join public.knowledge_chunks c on c.id = fused.id
  join public.knowledge_documents d on d.id = c.document_id
  order by fused.score desc
  limit match_count
$$;
