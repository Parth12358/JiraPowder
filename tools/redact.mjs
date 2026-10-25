#!/usr/bin/env node
// Redacts raw probe output (probe-out/*.json) for committing as test fixtures.
// Replaces names, emails, account IDs, avatars, site URLs, summaries and descriptions with
// stable fake values. Keeps issue keys, statuses, types, priorities, link structure,
// sprint ids/states and custom field IDs.
//
//   node tools/redact.mjs probe-out src-tauri/tests/fixtures
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [inDir = 'probe-out', outDir = 'src-tauri/tests/fixtures'] = process.argv.slice(2);
const FAKE_SITE = 'https://example.atlassian.net';
const maps = new Map(); // kind → (real → fake)
const fake = (kind, real, make) => {
  if (!maps.has(kind)) maps.set(kind, new Map());
  const m = maps.get(kind);
  if (!m.has(real)) m.set(real, make(m.size + 1));
  return m.get(real);
};

const PERSON_KEYS = new Set(['display_name', 'displayName', 'name_user', 'reporter_name']);
const SECRETISH = /^(email|emailAddress|avatar_url|avatarUrls|account_id|accountId|key_user|self)$/;
const TEXT_KEYS = new Set(['summary', 'description', 'goal', 'body', 'comment', 'text_body']);

let siteRe = null;

function redactString(s) {
  let out = siteRe ? s.replace(siteRe, FAKE_SITE) : s;
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (e) => fake('email', e, (n) => `person${n}@example.com`));
  return out;
}

function walk(v, key, parent) {
  if (Array.isArray(v)) return v.map((x) => walk(x, key, parent));
  if (v && typeof v === 'object') {
    const isUser = 'account_id' in v || 'accountId' in v || 'display_name' in v || 'displayName' in v || 'emailAddress' in v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (isUser && (k === 'name' || PERSON_KEYS.has(k)) && typeof x === 'string' && x !== 'Unassigned')
        o[k] = fake('person', x, (n) => `Person ${String.fromCharCode(64 + ((n - 1) % 26) + 1)}${n > 26 ? n : ''}`);
      else if (PERSON_KEYS.has(k) && typeof x === 'string' && x !== 'Unassigned')
        o[k] = fake('person', x, (n) => `Person ${String.fromCharCode(64 + ((n - 1) % 26) + 1)}${n > 26 ? n : ''}`);
      else if ((k === 'account_id' || k === 'accountId') && typeof x === 'string') o[k] = fake('acct', x, (n) => `acc-${String(n).padStart(4, '0')}`);
      else if (k === 'avatar_url' || k === 'avatarUrls') o[k] = `${FAKE_SITE}/avatar`;
      else if ((k === 'email' || k === 'emailAddress') && typeof x === 'string') o[k] = fake('email', x, (n) => `person${n}@example.com`);
      else if (TEXT_KEYS.has(k) && typeof x === 'string') o[k] = fake('text', x, (n) => `Redacted text ${n}`);
      else if (k === 'text' && typeof x === 'string' && /^\s*[{[]/.test(x)) {
        // MCP text content holding JSON: redact inside it too.
        try { o[k] = JSON.stringify(walk(JSON.parse(x)), null, 2); } catch { o[k] = redactString(x); }
      } else if (k === 'result' && typeof x === 'string' && /^\s*[{[]/.test(x)) {
        try { o[k] = JSON.stringify(walk(JSON.parse(x)), null, 2); } catch { o[k] = redactString(x); }
      } else o[k] = walk(x, k, v);
    }
    return o;
  }
  if (typeof v === 'string') return SECRETISH.test(key ?? '') ? redactString(v) : redactString(v);
  return v;
}

// Learn the real site from any browse_url / self URL.
const files = readdirSync(inDir).filter((f) => f.endsWith('.json') && f !== 'tools.json');
for (const f of files) {
  const m = readFileSync(join(inDir, f), 'utf8').match(/https:\/\/([a-z0-9-]+)\.atlassian\.net/i);
  if (m) {
    siteRe = new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    break;
  }
}
mkdirSync(outDir, { recursive: true });
for (const f of files) {
  const out = walk(JSON.parse(readFileSync(join(inDir, f), 'utf8')));
  writeFileSync(join(outDir, 'real_' + f), JSON.stringify(out, null, 2) + '\n');
  console.log(`redacted ${f} → ${join(outDir, 'real_' + f)}`);
}
console.log('Check before committing:  grep -rniE "@|atlassian.net" ' + outDir + ' | grep -v example');
