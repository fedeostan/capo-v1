import { readFileSync, writeFileSync } from 'node:fs';
const FILES = [
  'packages/core/src/agent/persona/worker.en-US.ts',
  'packages/core/src/agent/persona/worker.es-ES.ts',
  'packages/core/src/agent/persona/worker.pt-PT.ts',
  'packages/core/src/agent/prompts/worker-orchestration.ts',
];
const FIXES: [string, string][] = [
  // headings
  ['# Capo, Persona and Voice (crew)', '# Capo: persona and voice (crew)'],
  ['# Capo, Persona y Voz (equipo)', '# Capo: persona y voz (equipo)'],
  ['# Capo, Persona e Voz (equipa)', '# Capo: persona e voz (equipa)'],
  // the new ask_manager persona line: a comma list inside a comma list
  ['- **Write down what they need**, materials, a tool, a machine, a delivery, anything, and get it to the manager.',
   '- **Write down what they need** (materials, a tool, a machine, a delivery, anything) and get it to the manager.'],
  ['- **Apuntas lo que necesita**, material, herramienta, máquina, una entrega, lo que sea, y se lo haces llegar al gerente.',
   '- **Apuntas lo que necesita** (material, herramienta, máquina, una entrega, lo que sea) y se lo haces llegar al gerente.'],
  ['- **Apontas o que ele precisa**, material, ferramenta, máquina, uma entrega, o que for, e fazes chegar isso ao gerente.',
   '- **Apontas o que ele precisa** (material, ferramenta, máquina, uma entrega, o que for) e fazes chegar isso ao gerente.'],
  // the new request section
  ['- **Ask what day it is needed for, once, in one line.**', '- **Ask what day it is needed for. Once, in one line.**'],
  ['never ask twice, a second question on a building site', 'never ask twice: a second question on a building site'],
  // pre-existing repairs, re-applied over main's text
  ['the most valuable thing you do, before this existed, the only options were',
   'the most valuable thing you do. Before this existed, the only options were'],
  ['For anything technical or legal, curing times, dosages, application standards, permits, obligations, call',
   'For anything technical or legal (curing times, dosages, application standards, permits, obligations) call'],
  ['If it is ambiguous, ask which one, do not guess', 'If it is ambiguous, ask which one. Do not guess'],
  ['no longer available on that second turn, ask them to send it again',
   'no longer available on that second turn. Ask them to send it again'],
  ['you do not need one, you have no capability that would matter',
   'you do not need one: you have no capability that would matter'],
];
const applied = new Set<number>();
for (const f of FILES) {
  let s = readFileSync(f, 'utf8');
  const before = s;
  FIXES.forEach(([a, b], i) => { if (s.includes(a)) { s = s.split(a).join(b); applied.add(i); } });
  if (s !== before) writeFileSync(f, s);
}
const missed = FIXES.map(([a], i) => (applied.has(i) ? null : a)).filter(Boolean);
if (missed.length) { console.error('FAILED, matched nothing:'); missed.forEach(m => console.error('  ' + m)); process.exit(1); }
console.log(`${FIXES.length}/${FIXES.length} repairs applied`);
