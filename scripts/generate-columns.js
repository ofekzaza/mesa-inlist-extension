#!/usr/bin/env node
/*
 * Generates data/mesa-columns.json from MESA's history_columns.list and
 * profile_columns.list, which define the valid output columns for the
 * history.data and profile.data files.
 *
 * Usage:
 *   node scripts/generate-columns.js [path/to/mesa]
 *   # or set MESA_DIR
 */
'use strict';

const fs = require('fs');
const path = require('path');

let MESA_ROOT = process.argv[2] || process.env.MESA_DIR || path.join(
  process.env.HOME || '/home/myusername',
  'Documents', 'mesa', 'mesa_26_04_1'
);

function resolve(...parts) {
  return path.join(MESA_ROOT, ...parts);
}

// Columns that take a following integer argument (e.g. `mixing_regions 10`).
const ARG_COLUMNS = {
  history: ['mixing_regions', 'mix_relr_regions', 'burning_regions', 'burn_relr_regions'],
  profile: [],
};

// Prefix-based columns (e.g. `center_h1`, `raw_rate_c12_ag_o16`) are added in
// bulk via the `add_*` directives and are not listed individually in the
// defaults files.  These prefixes come from do1_history_spec in history_specs.f90.
const HISTORY_PREFIXES = [
  'raw_rate_', 'screened_rate_', 'eps_nuc_rate_', 'eps_neu_rate_',
  'abs_mag_', 'bc_', 'lum_band_', 'log_lum_band_',
  'center_', 'surface_', 'average_', 'total_mass_', 'log_total_mass_',
  'log_average_', 'log_center_', 'log_surface_',
  'max_eps_nuc_log_xa_', 'cz_top_log_xa_', 'cz_log_xa_', 'c_log_eps_burn_',
];
const PROFILE_PREFIXES = [];

/**
 * Parse a columns .list file.  A column is a line whose first token is an
 * identifier, optionally prefixed by a single `!` with no space (a commented-out
 * column).  Lines whose `!` is followed by a space or `#` are prose comments or
 * section headers and are ignored.  Both active and commented-out columns are
 * valid names; the inline comment is kept as the description.
 */
function parseColumnsFile(text, type) {
  const entries = [];
  const byName = new Map();

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let rest = trimmed;
    if (rest.startsWith('!')) {
      const after = rest.slice(1);
      if (!/^[a-zA-Z_]/.test(after)) continue; // prose comment / section header
      rest = after; // commented-out column
    }

    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(.*)$/.exec(rest);
    if (!m) continue;
    const name = m[1];
    const after = m[2] || '';

    let kind = 'column';
    if (name === 'include') kind = 'directive';
    else if (/^add_[a-z]/.test(name)) kind = 'directive';
    else if (ARG_COLUMNS[type].includes(name)) kind = 'argcolumn';

    let desc = '';
    if (kind === 'column' || kind === 'argcolumn') {
      const bang = after.indexOf('!');
      if (bang !== -1) desc = after.slice(bang + 1).trim();
      else desc = after.replace(/^\s*<[^>]*>\s*/, '').trim();
    }

    const prev = byName.get(name);
    if (prev) {
      if (desc && !prev.desc) prev.desc = desc;
      continue;
    }
    const entry = { name, kind, desc };
    byName.set(name, entry);
    entries.push(entry);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function main() {
  const historyFile = resolve('star/defaults/history_columns.list');
  const profileFile = resolve('star/defaults/profile_columns.list');
  if (!fs.existsSync(historyFile)) {
    console.error('ERROR: could not find MESA tree at ' + MESA_ROOT);
    process.exit(1);
  }

  const out = {
    version: '26.4.1',
    generatedAt: new Date().toISOString(),
    history: parseColumnsFile(fs.readFileSync(historyFile, 'utf8'), 'history'),
    profile: parseColumnsFile(fs.readFileSync(profileFile, 'utf8'), 'profile'),
    historyPrefixes: HISTORY_PREFIXES,
    profilePrefixes: PROFILE_PREFIXES,
  };

  // `include 'filename'` is a valid directive but appears in the defaults only
  // as a comment with a space after `!`, so add it explicitly.
  for (const type of ['history', 'profile']) {
    const entries = out[type];
    if (!entries.some((e) => e.name === 'include')) {
      entries.push({
        name: 'include',
        kind: 'directive',
        desc: "Include another columns list file. `include ''` means include the default file.",
      });
      entries.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'mesa-columns.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  console.log('Generated ' + outFile);
  console.log('  history columns: ' + out.history.length + ' (prefixes: ' + out.historyPrefixes.length + ')');
  console.log('  profile columns: ' + out.profile.length + ' (prefixes: ' + out.profilePrefixes.length + ')');
}

main();
