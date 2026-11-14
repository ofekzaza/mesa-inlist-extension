#!/usr/bin/env node
/*
 * Generates data/mesa-defaults.json from a MESA source tree.
 *
 * Sources of truth:
 *   1. The `.defaults` files (control names, default values, docs, namelist membership).
 *   2. The Fortran `.inc` / module `.f90` files (exact types: real / integer / logical / character).
 *
 * Usage:
 *   node scripts/generate-defaults.js [path/to/mesa]
 *   # or set MESA_DIR
 *
 * The MESA root defaults to ~/Documents/mesa/mesa_26_04_1 if nothing is given.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// MESA root resolution
// ---------------------------------------------------------------------------
let MESA_ROOT = process.argv[2] || process.env.MESA_DIR || path.join(
  process.env.HOME || '/home/myusername',
  'Documents', 'mesa', 'mesa_26_04_1'
);

function resolve(...parts) {
  return path.join(MESA_ROOT, ...parts);
}

// ---------------------------------------------------------------------------
// Namelist -> .defaults files (order matters: main first, dev merged after)
// ---------------------------------------------------------------------------
const NAMELIST_DEFAULTS = [
  { namelist: 'star_job',    files: ['star/defaults/star_job.defaults', 'star/defaults/star_job_dev.defaults'] },
  { namelist: 'controls',    files: ['star/defaults/controls.defaults', 'star/defaults/controls_dev.defaults'] },
  { namelist: 'pgstar',      files: ['star/defaults/pgstar.defaults'] },
  { namelist: 'binary_job',  files: ['binary/defaults/binary_job.defaults'] },
  { namelist: 'binary_controls', files: ['binary/defaults/binary_controls.defaults'] },
  { namelist: 'pgbinary',    files: ['binary/defaults/pgbinary.defaults'] },
  { namelist: 'eos',         files: ['eos/defaults/eos.defaults'] },
  { namelist: 'kap',         files: ['kap/defaults/kap.defaults'] },
  { namelist: 'colors',      files: ['colors/defaults/colors.defaults'] },
  { namelist: 'astero_search_controls',  files: ['astero/defaults/astero_search.defaults'] },
  { namelist: 'astero_pgstar_controls',  files: ['astero/defaults/astero_pgstar.defaults'] },
  { namelist: 'simplex_search_controls', files: ['star/test_suite/simplex_solar_calibration/defaults/simplex_search.defaults'] },
];

// Fortran declaration files used to infer exact variable types.
const DECLARATION_FILES = [
  'star_data/private/star_controls.inc',
  'star_data/private/star_controls_dev.inc',
  'star_data/private/star_job_controls.inc',
  'star_data/private/star_job_controls_dev.inc',
  'star_data/private/pgstar_controls.inc',
  'binary/public/binary_controls.inc',
  'binary/private/binary_job_controls.inc',
  'binary/public/pgbinary_controls.inc',
  'eos/private/eos_ctrls_io.f90',
  'kap/private/kap_ctrls_io.f90',
  'colors/private/colors_ctrls_io.f90',
  'astero/public/astero_def.f90',
  'binary/private/binary_ctrls_io.f90',
  'star/test_suite/simplex_solar_calibration/src/simplex_search_data.f90',
];

// Fortran `namelist /.../` declarations are the authoritative list of valid
// control names.  A handful of controls are read by the namelist reader but are
// not listed as `name = value` lines in the `.defaults` files (they appear only
// as `!!` documentation or are declared directly in the reader module).
const NAMELIST_DECLARATIONS = {
  controls: 'star/private/ctrls_io.f90',
  star_job: 'star/private/star_job_ctrls_io.f90',
  pgstar: 'star/private/pgstar_ctrls_io.f90',
  binary_controls: 'binary/private/binary_ctrls_io.f90',
  binary_job: 'binary/private/binary_job_ctrls_io.f90',
  pgbinary: 'binary/private/pgbinary_ctrls_io.f90',
  eos: 'eos/private/eos_ctrls_io.f90',
  kap: 'kap/private/kap_ctrls_io.f90',
  colors: 'colors/private/colors_ctrls_io.f90',
  astero_search_controls: 'astero/public/astero_def.f90',
  astero_pgstar_controls: 'astero/public/astero_def.f90',
};

// A small curated set of enum values for very common string controls that are
// documented in prose rather than as a machine-parseable option list.
const MANUAL_ENUMS = {
  terminal_show_age_units: ['years', 'yrs', 'days', 'secs', 'seconds'],
  terminal_show_timestep_units: ['years', 'yrs', 'days', 'secs', 'seconds'],
  overshoot_scheme: ['none'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stripInlineComment(line) {
  // Remove a trailing `! ...` comment.  Declaration files don't have string
  // literals with `!` in them, so a naive split is safe here.
  const idx = line.indexOf('!');
  if (idx === -1) return line;
  return line.slice(0, idx);
}

/**
 * Parse Fortran variable declarations into name -> { type, isArray }.
 * Handles continuation lines (`&`), multi-name statements, array dims,
 * `dimension(...)` attributes, and skips `parameter` constants / `intent` args.
 */
function parseFortranDeclarations(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);

  const statements = [];
  let cur = '';
  for (const raw of lines) {
    let line = stripInlineComment(raw).trim();
    if (!line) continue;
    cur += (cur ? ' ' : '') + line;
    if (/&\s*$/.test(cur)) {
      cur = cur.replace(/&\s*$/, '').trimEnd();
      continue;
    }
    statements.push(cur);
    cur = '';
  }
  if (cur.trim()) statements.push(cur);

  for (const stmt of statements) {
    const typeMatch = /^\s*(real|integer|logical|character)\b/i.exec(stmt);
    if (!typeMatch) continue;
    const kind = typeMatch[1].toLowerCase();

    // Skip constants (`parameter`) and subroutine dummy arguments (`intent`).
    if (/\bparameter\b/i.test(stmt) || /\bintent\b/i.test(stmt)) continue;

    const dd = stmt.indexOf('::');
    if (dd === -1) continue;

    const hasDimension = /\bdimension\b/i.test(stmt.slice(0, dd));
    const nameList = stmt.slice(dd + 2);
    for (let tok of nameList.split(',')) {
      tok = tok.trim();
      if (!tok) continue;
      // Strip any trailing `= value` (only appears on parameters, already skipped).
      tok = tok.split('=')[0].trim();
      let base = tok;
      let isArray = hasDimension;
      const arr = /^([a-zA-Z_]\w*)\s*\(/.exec(tok);
      if (arr) {
        base = arr[1];
        isArray = true;
      }
      if (!/^[a-zA-Z_]\w*$/.test(base)) continue;

      const type =
        kind === 'character' ? 'string' :
        kind === 'logical'   ? 'boolean' :
        kind === 'integer'   ? 'integer' :
        'real';

      const existing = map.get(base);
      if (existing) {
        existing.isArray = existing.isArray || isArray;
      } else {
        map.set(base, { type, isArray });
      }
    }
  }
  return map;
}

function inferTypeFromValue(value) {
  const v = value.trim();
  if (/^['"]/.test(v)) return 'string';
  if (/^\.(true|false|t|f)\.?$/i.test(v)) return 'boolean';
  if (/^[+-]?\d+$/.test(v)) return 'integer';
  return 'real';
}

/**
 * Parse a Fortran `namelist /name/` declaration to get the authoritative list
 * of control names in that namelist (handles `&` continuation lines and
 * interspersed `!` comments).
 */
function parseNamelistDeclaration(text, targetName) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp('namelist\\s*/\\s*' + targetName + '\\s*/');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let buf = stripInlineComment(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      const l = stripInlineComment(lines[j]).trim();
      if (!l) continue;
      buf += ' ' + l;
      if (!/&\s*$/.test(l)) break;
    }
    const names = [];
    for (const m of buf.matchAll(/\b[a-zA-Z_]\w*\b/g)) names.push(m[0]);
    return names.filter((x) => x !== 'namelist' && x !== targetName);
  }
  return [];
}

function extractInlineEnums(comment) {
  const enums = [];
  if (!comment) return enums;
  const re = /``([^`]+)``/g;
  let m;
  while ((m = re.exec(comment)) !== null) {
    const v = m[1].trim();
    if (/^[a-zA-Z0-9_]+$/.test(v)) enums.push(v);
  }
  return enums;
}

const ENUM_KEYWORD = /options? are|available options|one of|either|choices?|must be|allowed values|can be set to/i;

function quotedTokens(line) {
  const out = [];
  const re = /'([^']+)'|"([^"]+)"/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const v = (m[1] || m[2] || '').trim();
    if (v && /^[a-zA-Z0-9_]+$/.test(v) && v.length <= 40) out.push(v);
  }
  return out;
}

function extractDocEnums(docLines) {
  // Option lists in MESA docs look like:
  //   ! Options are:
  //   ! + 'none'       : description
  //   ! - 'TDC'        : description
  //   ! + ``'table'``  : description
  // Some options are described in prose ("Available options are ``'dedt'`` or ``'eps_grav'``").
  const enums = [];
  for (const line of docLines) {
    if (/^\s*[+\-*]\s+/.test(line) || ENUM_KEYWORD.test(line)) {
      enums.push(...quotedTokens(line));
    }
  }
  return enums;
}

function cleanDoc(docLines) {
  const cleaned = [];
  for (const line of docLines) {
    let s = line.trim();
    if (!s) continue;
    // Drop pure underline/divider runs (e.g. "~~~~~~~~~", "=========").
    if (/^[~=_\-*.]{3,}$/.test(s)) continue;
    // Collapse reST list markers a bit for readability.
    s = s.replace(/^([+\-*])\s+/, '$1 ');
    cleaned.push(s);
  }
  let text = cleaned.join('\n').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length > 1600) {
    text = text.slice(0, 1600) + '…';
  }
  return text;
}

function parseDefaultsFile(text, typeMap) {
  const lines = text.split(/\r?\n/);
  const controls = [];
  const byName = new Map();
  let docLines = [];

  const controlRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\([^)]*\))?\s*=\s*([^!]*?)\s*(!.*)?$/;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed.startsWith('!')) {
      const content = raw.replace(/^\s*!\s?/, '');
      // A `=` divider marks a new top-level section: reset accumulated docs.
      if (/^={3,}\s*$/.test(content.trim())) {
        docLines = [];
        continue;
      }
      if (content.trim() === '') continue; // blank comment line
      docLines.push(content);
      continue;
    }

    const m = controlRe.exec(raw);
    if (m) {
      const name = m[1];
      const arrSpec = m[2] || '';
      const valueRaw = m[3].trim();
      const inlineComment = (m[4] || '').replace(/^!\s?/, '').trim();

      const inferredType = inferTypeFromValue(valueRaw);
      let enums = extractInlineEnums(inlineComment);

      // Enums from option-list doc lines (only meaningful for string controls).
      if (inferredType === 'string') {
        enums = enums.concat(extractDocEnums(docLines));
      }

      // Exact type from the Fortran declarations wins over value inference.
      let type = inferredType;
      let isArray = arrSpec.includes('(');
      const decl = typeMap.get(name);
      if (decl) {
        type = decl.type;
        isArray = isArray || decl.isArray;
      }

      const manual = MANUAL_ENUMS[name];
      if (manual) enums = enums.concat(manual);
      enums = Array.from(new Set(enums));

      // The documented default value is always a valid option, so include it in
      // the enum list when the control has any (keeps multi-word defaults such
      // as semiconvection_option = 'Langer_85 mixing; gradT = gradr' valid).
      if (type === 'string' && enums.length > 0) {
        const dm = /^'([^']*)'$|^"([^"]*)"$/.exec(valueRaw);
        const dv = dm ? (dm[1] ?? dm[2]).trim() : '';
        if (dv !== '') enums.push(dv);
        enums = Array.from(new Set(enums));
      }

      const doc = cleanDoc(docLines);
      const entry = {
        name,
        type,
        default: valueRaw,
        doc,
        enums,
        isArray,
      };

      const prev = byName.get(name);
      if (prev) {
        if (enums.length) prev.enums = Array.from(new Set([...prev.enums, ...enums]));
        prev.isArray = prev.isArray || isArray;
      } else {
        byName.set(name, entry);
        controls.push(entry);
      }

      docLines = [];
      continue;
    }

    // Any other non-comment, non-control line (stray content) resets docs.
    if (trimmed !== '') docLines = [];
  }

  return controls;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(resolve('star/defaults/controls.defaults'))) {
    console.error('ERROR: could not find MESA tree at ' + MESA_ROOT);
    console.error('Pass the path as the first argument or set MESA_DIR.');
    process.exit(1);
  }

  // 1) Build the global type map from Fortran declarations.
  const typeMap = new Map();
  for (const rel of DECLARATION_FILES) {
    const p = resolve(rel);
    if (!fs.existsSync(p)) {
      console.warn('WARN: declaration file not found, skipping: ' + rel);
      continue;
    }
    const m = parseFortranDeclarations(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of m) {
      const existing = typeMap.get(k);
      if (existing) {
        existing.isArray = existing.isArray || v.isArray;
      } else {
        typeMap.set(k, v);
      }
    }
  }

  // 2) Parse the defaults files into per-namelist control lists.
  const namelists = {};
  let total = 0;
  for (const { namelist, files } of NAMELIST_DEFAULTS) {
    const controls = [];
    const byName = new Map();
    for (const rel of files) {
      const p = resolve(rel);
      if (!fs.existsSync(p)) {
        console.warn('WARN: defaults file not found, skipping: ' + rel);
        continue;
      }
      for (const c of parseDefaultsFile(fs.readFileSync(p, 'utf8'), typeMap)) {
        const prev = byName.get(c.name);
        if (prev) {
          if (c.enums.length) prev.enums = Array.from(new Set([...prev.enums, ...c.enums]));
          prev.isArray = prev.isArray || c.isArray;
          continue;
        }
        byName.set(c.name, c);
        controls.push(c);
      }
    }
    controls.sort((a, b) => a.name.localeCompare(b.name));

    // Merge in any controls declared in the namelist statement but absent from
    // the `.defaults` files (hidden controls such as `kap_file_prefix`,
    // `user_num_kap_Xs`, `Color_Magnitude1_win_flag`, ...).  Their type comes
    // from the declaration map.  Skip internal pgstar bookkeeping variables
    // (do_/id_/prev_ prefixes).
    const declFile = NAMELIST_DECLARATIONS[namelist];
    if (declFile) {
      const p = resolve(declFile);
      if (fs.existsSync(p)) {
        const declared = parseNamelistDeclaration(fs.readFileSync(p, 'utf8'), namelist);
        for (const name of declared) {
          if (controls.some((x) => x.name === name)) continue;
          if (/^(do_|id_|prev_)/.test(name)) continue;
          const decl = typeMap.get(name);
          controls.push({
            name,
            type: decl ? decl.type : 'real',
            default: '',
            doc: 'Declared in the namelist statement but not documented in the defaults file.',
            enums: [],
            isArray: decl ? decl.isArray : false,
          });
        }
        controls.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    namelists[namelist] = controls;
    total += controls.length;
  }

  // 3) Emit JSON.
  const out = {
    version: '26.4.1',
    generatedAt: new Date().toISOString(),
    mesaRoot: MESA_ROOT,
    controlCount: total,
    namelists,
  };

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'mesa-defaults.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');

  console.log('Generated ' + outFile);
  console.log('Controls: ' + total);
  for (const [n, c] of Object.entries(namelists)) {
    console.log('  &' + n + ' : ' + c.length + ' controls');
  }
}

main();
