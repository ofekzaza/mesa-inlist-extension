// Broad scan: validate every inlist-like file under the MESA tree and report
// unique issues (controls the database might be missing or mistyped).
'use strict';
const fs = require('fs');
const path = require('path');
const { parse, inferValueType, unquote, isIntegralReal, splitValueList } = require('../out/parser.js');
const db = require('../data/mesa-defaults.json');

const namelists = db.namelists;
const byNamelist = new Map();
const locations = new Map();
for (const [nl, controls] of Object.entries(namelists)) {
  const m = new Map();
  for (const c of controls) {
    m.set(c.name.toLowerCase(), c);
    const k = c.name.toLowerCase();
    const loc = locations.get(k);
    if (loc) loc.push(nl); else locations.set(k, [nl]);
  }
  byNamelist.set(nl, m);
}
const knownNamelists = new Set(Object.keys(namelists));

const MESA = '/home/myusername/Documents/mesa/mesa_26_04_1';
const unique = new Map(); // key -> {kind, example}
let files = 0, assignments = 0, cleanFiles = 0;

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'make' || e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/inlist/.test(e.name)) out.push(p);
  }
  return out;
}

for (const f of walk(MESA)) {
  files++;
  const text = fs.readFileSync(f, 'utf8');
  const doc = parse(text);
  let had = false;
  for (const a of doc.assignments) {
    assignments++;
    if (!a.namelist) continue;
    if (!knownNamelists.has(a.namelist)) {
      // Custom namelists (run_star_extras hooks) are expected; skip silently.
      continue;
    }
    const def = byNamelist.get(a.namelist).get(a.baseName.toLowerCase());
    if (!def) {
      const locs = locations.get(a.baseName.toLowerCase()) || [];
      let msg;
      if (locs.length) msg = `WRONG-SECTION &${a.namelist} ${a.name} -> &${locs[0]}`;
      else msg = `UNKNOWN &${a.namelist} ${a.name}`;
      if (!unique.has(msg)) unique.set(msg, { f, line: a.line + 1 });
      had = true;
      continue;
    }
    const parts = splitValueList(a.value);
    let bad = null;
    for (const part of parts) {
      const vt = inferValueType(part);
      if (def.type === 'boolean' && vt !== 'boolean') bad = `boolean(${vt})`;
      else if (def.type === 'integer' && !(vt === 'integer' || (vt === 'real' && isIntegralReal(part)))) bad = `integer(${vt})`;
      else if (def.type === 'real' && vt !== 'integer' && vt !== 'real') bad = `real(${vt})`;
      else if (def.type === 'string' && vt !== 'string') bad = `string(${vt})`;
      else if (def.type === 'string' && def.enums.length) {
        const inner = unquote(part);
        if (inner && inner !== '' && !def.enums.includes(inner)) bad = `enum '${inner}' ∉ [${def.enums}]`;
      }
      if (bad) break;
    }
    if (bad) {
      const msg = `TYPE &${a.namelist} ${a.name} = ${a.value} (${bad})`;
      if (!unique.has(msg)) unique.set(msg, { f, line: a.line + 1 });
      had = true;
    }
  }
  if (!had) cleanFiles++;
}

console.log(`Scanned ${files} files, ${assignments} assignments.`);
console.log(`Clean files: ${cleanFiles}. Unique issues: ${unique.size}`);
console.log('--- issues ---');
for (const [msg, info] of unique) {
  console.log(`${msg}\n    at ${info.f}:${info.line}`);
}
