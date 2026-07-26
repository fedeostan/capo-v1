// Markdown → WhatsApp text conversion.
//
// Capo's persona and prompts are authored in markdown (`**bold**`, `#`
// headings, `[text](url)`), so its prose comes out of the model as markdown.
// The web chat renders that with react-markdown; WhatsApp has its own, much
// smaller dialect — crucially **bold is a SINGLE asterisk** — so shipping the
// same bytes to WhatsApp leaves literal asterisks all over the manager's
// screen ("*Casa de Paco*" instead of a bold job name).
//
// This is a deterministic conversion at the channel edge rather than a prompt
// telling the model which dialect to write. A prompt is unverifiable and one
// edit away from silently regressing; a pure function is asserted in
// scripts/whatsapp-check.mts.
//
// WhatsApp supports: *bold*, _italic_, ~strike~, ```block```, `inline`,
// "- item" / "1. item" lists, and "> quote". It does NOT support headings,
// link syntax (bare URLs auto-link on their own), or **double asterisks**.
//
// ── Order matters. The traps this sequence exists to avoid: ────────────────
//
// - `***` is handled before `**`, and `**` before anything touching a single
//   `*`, or emphasis shreds into unbalanced markers.
// - There is deliberately NO single-`*` → `_` italic pass. Markdown `*x*` is
//   italic and WhatsApp `*x*` is bold, so the "correct" mapping is `*x*` →
//   `_x_` — and it is a trap, because that is exactly the shape the bold pass
//   just produced, so it would immediately undo its own work. A literal
//   asterisk is also indistinguishable from a markdown italic. Emphasis
//   degrading from italic to bold is harmless; corrupting the bold we just
//   produced is not.
// - Emphasis patterns use `[^\n]*?`, never `[\s\S]*?`. That is what stops a
//   bullet list ("* a\n* b") from being swallowed as one bold span — and it
//   is why bullets are normalised BEFORE emphasis runs.
// - Code is extracted first and restored last. WhatsApp renders both fence
//   styles natively, so the placeholders restore byte-identical and a code
//   block containing `**` survives untouched.
// - Headings run last and strip inner `*`/`_`: by that point "## **Prazo**"
//   is already "## *Prazo*", and wrapping it naively yields "*a *b* c*",
//   which WhatsApp renders as garbage.
//
// ── Documented non-goals ───────────────────────────────────────────────────
//
// - `snake_case` renders italic on WhatsApp and cannot be fixed: WhatsApp has
//   no escape character, so any "fix" would have to mutate the manager's text.
// - Markdown tables degrade to noisy pipe rows. If that ever matters the fix
//   is a prompt change, not more regex.
// - `f(f(x)) === f(x)` is a required property (asserted in the check script):
//   the sink must be safe to run over already-converted text.

const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;

// Private-use-area sentinels. NOT control characters: a control character
// inside a regex literal trips ESLint's `no-control-regex`, which is an error
// under this repo's config.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

// One shared store for fences and inline code, so a single restore pass
// cannot confuse two independent index spaces. Fences are lifted first, and
// their placeholders contain no backticks, so the inline pass cannot reach
// inside one.
function protect(input: string, pattern: RegExp, store: string[]): string {
  return input.replace(pattern, match => {
    store.push(match);
    return `${OPEN}${store.length - 1}${CLOSE}`;
  });
}

function restore(input: string, store: string[]): string {
  return input.replace(PLACEHOLDER, (whole, index: string) => store[Number(index)] ?? whole);
}

export function toWhatsAppMarkdown(input: string): string {
  const code: string[] = [];

  let out = input.replace(/\r\n/g, '\n');

  out = protect(out, FENCE, code);
  out = protect(out, INLINE_CODE, code);

  // Images before links — `![alt](url)` is the link pattern with a leading `!`.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) =>
    alt ? `${alt} (${url})` : url,
  );
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) =>
    text === url ? url : `${text} (${url})`,
  );

  // Horizontal rules before bullets and emphasis: `***` and `---` are rule
  // syntax, not a list marker and not bold.
  out = out.replace(/^ {0,3}([-*_])(?: *\1){2,} *$/gm, '');

  // Bullets before emphasis, so a line-leading `*` is already a `-` by the
  // time the bold passes look for asterisk pairs. `-` and `1.` already render
  // natively and are left alone.
  out = out.replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ');

  out = out.replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '*_$1_*');
  out = out.replace(/___(?=\S)([^\n]*?\S)___/g, '*_$1_*');
  out = out.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '*$1*');
  out = out.replace(/__(?=\S)([^\n]*?\S)__/g, '*$1*');

  out = out.replace(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_m, title: string) => {
    const flat = title.replace(/[*_]/g, '').trim();
    return flat ? `*${flat}*` : '';
  });

  out = out.replace(/\n{3,}/g, '\n\n');

  return restore(out, code).trim();
}
