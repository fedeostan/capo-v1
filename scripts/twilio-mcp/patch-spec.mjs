// Twilio's OpenAPI spec names some list-filter query params with a literal
// trailing "<" or ">" (e.g. "DateCreated<", "StartTime>", for inequality
// filtering). @twilio-alpha/mcp turns each param straight into a JSON Schema
// property key, but Anthropic's tool validation requires every key to match
// ^[a-zA-Z0-9_.-]{1,64}$ — so a single one of these params anywhere in the
// loaded spec makes the ENTIRE tool list get rejected with a 400, breaking
// every tool call in the session (not just the affected one).
//
// These params are also currently inert for GET requests in this alpha SDK
// (it only interpolates {path} params for GET, never serializes a query
// string), so renaming them here changes no request behavior — it only
// unblocks tool-list validation. Idempotent: safe to run on every launch.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.join(__dirname, 'node_modules/@twilio-alpha/mcp/twilio-oai/spec/yaml');

const badNameLine = /^(\s*- name: )(\S+)([<>])(\s*)$/;
const suffix = { '<': '.Before', '>': '.After' };

let totalPatched = 0;
for (const file of readdirSync(specDir)) {
  if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
  const fullPath = path.join(specDir, file);
  const lines = readFileSync(fullPath, 'utf8').split('\n');
  let patched = 0;
  const next = lines.map(line => {
    const m = line.match(badNameLine);
    if (!m) return line;
    const [, prefix, base, bracket, trailing] = m;
    patched++;
    return `${prefix}${base}${suffix[bracket]}${trailing}`;
  });
  if (patched > 0) {
    writeFileSync(fullPath, next.join('\n'));
    console.error(`twilio-mcp patch: fixed ${patched} invalid tool param name(s) in ${file}`);
    totalPatched += patched;
  }
}

if (totalPatched === 0) {
  console.error('twilio-mcp patch: spec already clean, nothing to do');
}
