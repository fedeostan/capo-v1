---
name: knowledge-ingest-folder
description: Use when the user wants to load, embed, or ingest documents into the Capo knowledge base — a folder, a batch of files, or URLs (PDFs, markdown, laws, fichas técnicas, manufacturer guides). Also use when resuming a previously interrupted bulk ingestion.
---

# Bulk-ingest a folder into the Capo knowledge base

## Overview

Ingestion is one CLI call per file; bulk work is a **manifest-driven loop**. The manifest file is the source of truth for what exists, what went in, and what was skipped — the job is done only when the database has been verified against it. Never work from memory of "which files I've done so far".

## CLI contract (reference — do not re-derive from source)

```
pnpm knowledge-ingest <file.pdf|file.md|file.txt|url> --title "..." --category <cat> [--published YYYY-MM-DD]
```

- Script: `scripts/knowledge-ingest.mts`. Run from repo root. Env comes from `apps/web/.env.local` (needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).
- Accepted sources: `.pdf`, `.md`/`.markdown`/`.txt`, or `http(s)` URL. Anything else must be converted first or skipped.
- PDFs/HTML are converted to markdown by Gemini, then chunked per heading and embedded. Long PDFs may print a truncation WARNING — that document must be split and re-ingested as parts.
- Re-running the same path/URL **replaces** that document (keyed on `source_ref`). Retries are safe.
- Run calls **sequentially**, never in parallel (Gemini + embedding rate limits).
- `--title` becomes the citation text users see and `--category` filters retrieval — they are product surface, not metadata trivia.

Categories: `lei` (diplomas: DL, leis, portarias) · `regulamento` (RGEU, RRAE, SCE/REH, normas) · `tecnica` (técnicas de aplicação, boas práticas) · `material` (specs de materiais) · `fabricante` (fichas técnicas Weber/Sika/Secil/Mapei, guias de fabricante).

## Process

1. **Inventory first, completely.** `find <folder> -type f | sort` (recursive — subfolders count). Write a manifest file at `docs/knowledge-ingest-manifests/<YYYY-MM-DD>-<folder-name>.md` with one row per file found — including junk and unsupported files:

   ```markdown
   | # | path | title | category | status | chunks |
   |---|------|-------|----------|--------|--------|
   | 1 | leis/RGEU.pdf | RGEU — Regulamento Geral das Edificações Urbanas | regulamento | pending | |
   | 2 | leis/Thumbs.db | — | — | skip: OS junk | |
   | 3 | notas/precos.xlsx | — | — | skip: unsupported (.xlsx — convert to .md/.txt to ingest) | |
   ```

   The row count MUST equal the `find` count. State both numbers in the manifest header.

2. **Title + category per row.** Derive from filename when unambiguous; when the filename doesn't tell you (e.g. `doc-final-v2.pdf`), open the file and read enough to decide — never guess a category for a file you haven't identified. Titles in European Portuguese, specific enough to cite ("Weber — Ficha técnica weber.col flex", not "ficha 3").

3. **Confirm ambiguities in one batch.** If any rows are uncertain (category judgment calls, unsupported files the user might want converted), ask about all of them in a single message before executing. Obvious rows don't need confirmation.

4. **Execute the loop.** For each `pending` row, run the CLI, then update that row **immediately** — `done` + chunk count from the output, `failed: <error>`, or `needs-split` if the truncation warning appeared. Update after every file, not in batches: an interrupted session must be resumable from the manifest alone.

5. **Retry `failed` rows once.** Still failing → leave `failed` with the error in the manifest.

6. **Verify against the database.** Count and list titles: `select title, category from knowledge_documents order by category, title` (Supabase MCP `execute_sql` or service-role query). Every `done` row must appear; `done` count must match. Mismatch = the manifest is wrong somewhere — reconcile before reporting.

7. **Report.** Totals (found / ingested / skipped / failed / needs-split), the manifest path, and what — if anything — needs the user (conversions, splits, failures).

## Common mistakes

| Mistake | Consequence | Fix |
|---|---|---|
| Working from a mental list instead of the manifest | Files silently missed at scale; unresumable after interruption | Manifest row per file, updated after every command |
| Ingesting junk/unsupported without marking them | User can't tell missed from skipped | Every found file gets a row, skips get a reason |
| Guessing category from a vague filename | Wrong retrieval filter, wrong citations | Open the file when the name doesn't identify it |
| Parallel ingestion to save time | Rate-limit failures mid-batch | Sequential, always |
| Ignoring the truncation WARNING on big PDFs | Law silently half-missing from corpus | Mark `needs-split`, tell the user |
| Declaring done without the DB check | Manifest says done, DB disagrees | Step 6 is mandatory |
