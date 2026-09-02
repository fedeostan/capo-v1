import { readFileSync, writeFileSync } from 'node:fs';
const DASH = /[‒–—―]/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;
function fixLine(l: string): string {
  return l
    .replace(/(\d)\s*[‒–—―]\s*(?=\d)/g, '$1-')
    .replace(/([,;:])\s*[‒–—―]\s*/g, '$1 ')
    .replace(/\s*[‒–—―]\s*/g, ', ');
}
for (const f of process.argv.slice(2)) {
  const before = readFileSync(f, 'utf8');
  const after = before.split('\n').map(l => (COMMENT.test(l) || !DASH.test(l) ? l : fixLine(l))).join('\n');
  if (after !== before) { writeFileSync(f, after); console.log('cleaned ' + f); }
}
