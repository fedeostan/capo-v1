// Knowledge-base ingestion CLI — the ONLY write path into knowledge_documents
// / knowledge_chunks (service role; the tables have no write policies).
//
//   pnpm knowledge-ingest <file.pdf|file.md|url> --title "..." --category lei [--published 2024-01-01]
//
// Pipeline: acquire the source as markdown (PDFs and HTML pages are converted
// by Gemini — same model family as the transcription role — which handles
// scanned Portuguese legal PDFs far better than text extraction), chunk it
// heading-aware (laws: per Artigo), embed with the shared @capo/core seam,
// and upsert. Re-ingesting the same source (path/URL) replaces the document
// and all its chunks — that is the law-update path.
//
// Env comes from apps/web/.env.local (same discipline as agent-smoke.mts):
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GOOGLE_GENERATIVE_AI_API_KEY.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// ── env (must land in process.env before the embedding seam reads it) ──────
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(repoRoot, 'apps/web/.env.local');
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in apps/web/.env.local`);
    process.exit(1);
  }
}

const { generateText } = await import('ai');
const { google } = await import('@ai-sdk/google');
const { embedDocuments } = await import('@capo/core/embeddings');

// ── args ────────────────────────────────────────────────────────────────────
const CATEGORIES = ['lei', 'regulamento', 'tecnica', 'material', 'fabricante'];
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    flags[a.slice(2)] = args[++i] ?? '';
  } else {
    positional.push(a);
  }
}
const source = positional[0];
const title = flags.title;
const category = flags.category;
const publishedAt = flags.published ?? null;
if (!source || !title || !category || !CATEGORIES.includes(category)) {
  console.error(
    `Usage: pnpm knowledge-ingest <file.pdf|file.md|url> --title "..." --category <${CATEGORIES.join('|')}> [--published YYYY-MM-DD]`,
  );
  process.exit(1);
}

// ── acquire markdown ────────────────────────────────────────────────────────
const CONVERT_PROMPT = `Converte este documento para markdown limpo e estruturado, em português europeu, preservando fielmente o conteúdo.
- Usa headings markdown para a estrutura real do documento. Num diploma legal: "## Artigo N.º" (com o título do artigo na mesma linha, ex.: "## Artigo 6.º — Isenção de licença"); capítulos/secções como "#".
- Preserva o texto integral — não resumas, não omitas números, prazos ou valores.
- Remove lixo de layout: cabeçalhos/rodapés repetidos, números de página, artefactos de OCR.
- Responde APENAS com o markdown, sem comentários.`;

async function pdfToMarkdown(data: Uint8Array, label: string): Promise<string> {
  console.log(`Converting PDF to markdown with Gemini (${label})…`);
  const result = await generateText({
    model: google('gemini-3.5-flash'),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', data, mediaType: 'application/pdf' },
          { type: 'text', text: CONVERT_PROMPT },
        ],
      },
    ],
  });
  if (result.finishReason === 'length') {
    console.warn(
      'WARNING: Gemini hit its output limit — the document was likely truncated. Split the PDF and ingest the parts as separate sources.',
    );
  }
  return result.text;
}

async function htmlToMarkdown(html: string): Promise<string> {
  console.log('Converting HTML to markdown with Gemini…');
  const result = await generateText({
    model: google('gemini-3.5-flash'),
    messages: [{ role: 'user', content: [{ type: 'text', text: `${CONVERT_PROMPT}\n\n<documento>\n${html}\n</documento>` }] }],
  });
  return result.text;
}

let sourceType: 'pdf' | 'url' | 'markdown';
let sourceRef: string;
let markdown: string;

if (/^https?:\/\//.test(source)) {
  sourceType = 'url';
  sourceRef = source;
  const res = await fetch(source);
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/pdf') || source.toLowerCase().endsWith('.pdf')) {
    markdown = await pdfToMarkdown(new Uint8Array(await res.arrayBuffer()), source);
  } else {
    markdown = await htmlToMarkdown(await res.text());
  }
} else if (source.toLowerCase().endsWith('.pdf')) {
  sourceType = 'pdf';
  sourceRef = path.resolve(source);
  markdown = await pdfToMarkdown(new Uint8Array(readFileSync(sourceRef)), path.basename(sourceRef));
} else if (/\.(md|markdown|txt)$/i.test(source)) {
  sourceType = 'markdown';
  sourceRef = path.resolve(source);
  markdown = readFileSync(sourceRef, 'utf8');
} else {
  console.error(`Unsupported source: ${source} (expected .pdf, .md/.markdown/.txt, or a URL)`);
  process.exit(1);
}

if (markdown.trim().length < 50) {
  console.error('Extracted markdown is nearly empty — refusing to ingest.');
  process.exit(1);
}

// ── chunking ────────────────────────────────────────────────────────────────
// Heading-aware: sections are formed at heading boundaries (never mid-Artigo),
// small siblings merge up to the target, oversized sections split on
// paragraphs. ~3000 chars ≈ 700 tokens of pt-PT text.
const TARGET_CHARS = 3000;
const MAX_CHARS = 4500;

interface Section {
  headingPath: string;
  text: string;
}

function splitSections(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) sections.push({ headingPath: stack.map(h => h.title).join(' > '), text });
    current = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
    }
    current.push(line);
  }
  flush();
  return sections;
}

function chunkSections(sections: Section[]): Section[] {
  const chunks: Section[] = [];
  for (const section of sections) {
    if (section.text.length <= MAX_CHARS) {
      // Merge with the previous chunk when both are small and share a parent
      // heading — keeps tiny consecutive Artigos together.
      const prev = chunks[chunks.length - 1];
      const sameParent =
        prev &&
        prev.headingPath.split(' > ').slice(0, -1).join(' > ') === section.headingPath.split(' > ').slice(0, -1).join(' > ');
      if (prev && sameParent && prev.text.length + section.text.length <= TARGET_CHARS) {
        prev.text = `${prev.text}\n\n${section.text}`;
        prev.headingPath = prev.headingPath === section.headingPath ? prev.headingPath : `${prev.headingPath} / ${section.headingPath.split(' > ').pop()}`;
      } else {
        chunks.push({ ...section });
      }
      continue;
    }
    // Oversized section: split on paragraph boundaries.
    let buffer = '';
    let part = 1;
    for (const para of section.text.split(/\n\n+/)) {
      if (buffer && buffer.length + para.length + 2 > TARGET_CHARS) {
        chunks.push({ headingPath: `${section.headingPath} (${part})`, text: buffer.trim() });
        part += 1;
        buffer = '';
      }
      buffer += `${para}\n\n`;
    }
    if (buffer.trim()) chunks.push({ headingPath: part > 1 ? `${section.headingPath} (${part})` : section.headingPath, text: buffer.trim() });
  }
  return chunks.filter(c => c.text.length > 0);
}

const chunks = chunkSections(splitSections(markdown));
if (chunks.length === 0) {
  console.error('Chunking produced nothing — aborting.');
  process.exit(1);
}
console.log(`Chunked into ${chunks.length} chunks (target ~${TARGET_CHARS} chars).`);

// ── embed ───────────────────────────────────────────────────────────────────
// Embed heading context together with the body — "Artigo 6.º — Isenção de
// licença" carries retrieval signal the bare paragraph text lacks.
console.log('Embedding chunks…');
const embeddings = await embedDocuments(chunks.map(c => (c.headingPath ? `${c.headingPath}\n\n${c.text}` : c.text)));

// ── upsert (replace-by-source_ref) ──────────────────────────────────────────
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const { data: existing } = await db.from('knowledge_documents').select('id').eq('source_ref', sourceRef).maybeSingle();
if (existing) {
  console.log(`Replacing existing document ${existing.id} (same source_ref).`);
  const { error } = await db.from('knowledge_documents').delete().eq('id', existing.id);
  if (error) {
    console.error(`Delete failed: ${error.message}`);
    process.exit(1);
  }
}

const { data: doc, error: docError } = await db
  .from('knowledge_documents')
  .insert({ title, source_type: sourceType, source_ref: sourceRef, category, published_at: publishedAt })
  .select('id')
  .single();
if (docError || !doc) {
  console.error(`Insert document failed: ${docError?.message}`);
  process.exit(1);
}

const rows = chunks.map((c, i) => ({
  document_id: doc.id,
  chunk_index: i,
  heading_path: c.headingPath,
  content: c.text,
  // pgvector's wire format is the JSON-array string ("[0.1,0.2,…]").
  embedding: JSON.stringify(embeddings[i]),
}));
for (let i = 0; i < rows.length; i += 100) {
  const { error } = await db.from('knowledge_chunks').insert(rows.slice(i, i + 100));
  if (error) {
    console.error(`Insert chunks failed at batch ${i / 100}: ${error.message}`);
    await db.from('knowledge_documents').delete().eq('id', doc.id); // no half-ingested docs
    process.exit(1);
  }
}

console.log(`\nIngested "${title}" [${category}] as ${doc.id}`);
console.log(`  source: ${sourceRef} (${sourceType})`);
console.log(`  chunks: ${rows.length}`);
console.log('  sample headings:');
for (const c of chunks.slice(0, 8)) console.log(`    - ${c.headingPath || '(sem heading)'} (${c.text.length} chars)`);
if (chunks.length > 8) console.log(`    … +${chunks.length - 8} more`);
