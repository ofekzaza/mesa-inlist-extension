// Standalone sanity test for parser + validation logic (no vscode).
'use strict';
const fs = require('fs');
const { parse, inferValueType, unquote, isIntegralReal } = require('../out/parser.js');
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

function check(text, label) {
  const doc = parse(text);
  const issues = [];
  for (const a of doc.assignments) {
    if (!a.namelist) { issues.push(`  [outside-namelist] ${a.name} = ${a.value}`); continue; }
    if (!knownNamelists.has(a.namelist)) { issues.push(`  [unknown-namelist &${a.namelist}] ${a.name} = ${a.value}`); continue; }
    const def = byNamelist.get(a.namelist).get(a.baseName.toLowerCase());
    if (!def) {
      const locs = locations.get(a.baseName.toLowerCase()) || [];
      if (locs.length) issues.push(`  [WRONG-SECTION] &${a.namelist} ${a.name} -> belongs to &${locs[0]}`);
      else issues.push(`  [UNKNOWN] &${a.namelist} ${a.name} = ${a.value}`);
      continue;
    }
    const vt = inferValueType(a.value);
    let ok = true, why = '';
    if (def.type === 'boolean' && vt !== 'boolean') { ok = false; why = `expected boolean got ${vt}`; }
    else if (def.type === 'integer' && vt === 'integer') {}
    else if (def.type === 'integer' && vt === 'real' && isIntegralReal(a.value)) {}
    else if (def.type === 'integer' && vt !== 'unknown') { ok = false; why = `expected integer got ${vt}`; }
    else if (def.type === 'real' && vt !== 'integer' && vt !== 'real') { ok = false; why = `expected real got ${vt}`; }
    else if (def.type === 'string' && vt !== 'string') { ok = false; why = `expected string got ${vt}`; }
    else if (def.type === 'string' && def.enums.length) {
      const inner = unquote(a.value);
      if (inner && inner !== '' && !def.enums.includes(inner)) { ok = false; why = `enum '${inner}' not in [${def.enums}]`; }
    }
    if (!ok) issues.push(`  [TYPE] &${a.namelist} ${a.name} = ${a.value} :: ${why}`);
  }
  console.log(`=== ${label} (${doc.assignments.length} assignments, ${issues.length} issues) ===`);
  for (const s of issues) console.log(s);
}

const files = [
  '/home/myusername/Documents/mesa/mesa_26_04_1/star/work/inlist',
  '/home/myusername/Documents/mesa/mesa_26_04_1/star/work/inlist_project',
  '/home/myusername/Documents/mesa/mesa_26_04_1/star/work/inlist_pgstar',
  '/home/myusername/Documents/mesa/mesa_26_04_1/astero/test_suite/astero_adipls/inlist_astero_adipls',
  '/home/myusername/Documents/mesa/mesa_26_04_1/astero/test_suite/astero_adipls/inlist_astero_search_controls',
  '/home/myusername/Documents/mesa/mesa_26_04_1/binary/test_suite/double_bh/inlist',
  '/home/myusername/Documents/mesa/mesa_26_04_1/binary/test_suite/double_bh/inlist_pgbinary',
];
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('MISSING ' + f); continue; }
  check(fs.readFileSync(f, 'utf8'), f.split('/').slice(-2).join('/'));
}
