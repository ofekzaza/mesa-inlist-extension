import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MesaDefaults, ControlDef, ControlType } from './types';
import { setDatabase } from './database';

/**
 * Runtime re-parser: rebuilds the control database from a MESA source tree.
 * Mirrors scripts/generate-defaults.js so the extension can be pointed at any
 * MESA version via `mesaInlist.mesaDir` and the "Reload" command.
 */

interface NamelistSpec {
  namelist: string;
  files: string[];
}

const NAMELIST_DEFAULTS: NamelistSpec[] = [
  { namelist: 'star_job', files: ['star/defaults/star_job.defaults', 'star/defaults/star_job_dev.defaults'] },
  { namelist: 'controls', files: ['star/defaults/controls.defaults', 'star/defaults/controls_dev.defaults'] },
  { namelist: 'pgstar', files: ['star/defaults/pgstar.defaults'] },
  { namelist: 'binary_job', files: ['binary/defaults/binary_job.defaults'] },
  { namelist: 'binary_controls', files: ['binary/defaults/binary_controls.defaults'] },
  { namelist: 'pgbinary', files: ['binary/defaults/pgbinary.defaults'] },
  { namelist: 'eos', files: ['eos/defaults/eos.defaults'] },
  { namelist: 'kap', files: ['kap/defaults/kap.defaults'] },
  { namelist: 'colors', files: ['colors/defaults/colors.defaults'] },
  { namelist: 'astero_search_controls', files: ['astero/defaults/astero_search.defaults'] },
  { namelist: 'astero_pgstar_controls', files: ['astero/defaults/astero_pgstar.defaults'] },
  { namelist: 'simplex_search_controls', files: ['star/test_suite/simplex_solar_calibration/defaults/simplex_search.defaults'] },
];

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
// control names (some controls are read but not documented in `.defaults`).
const NAMELIST_DECLARATIONS: Record<string, string> = {
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

const ENUM_KEYWORD = /options? are|available options|one of|either|choices?|must be|allowed values|can be set to/i;

const MANUAL_ENUMS: Record<string, string[]> = {
  terminal_show_age_units: ['years', 'yrs', 'days', 'secs', 'seconds'],
  terminal_show_timestep_units: ['years', 'yrs', 'days', 'secs', 'seconds'],
  overshoot_scheme: ['none'],
};

function stripComment(line: string): string {
  const i = line.indexOf('!');
  return i === -1 ? line : line.slice(0, i);
}

function parseDeclarations(text: string): Map<string, { type: ControlType; isArray: boolean }> {
  const map = new Map<string, { type: ControlType; isArray: boolean }>();
  const statements: string[] = [];
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
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
    const tm = /^\s*(real|integer|logical|character)\b/i.exec(stmt);
    if (!tm) continue;
    const kind = tm[1].toLowerCase();
    if (/\bparameter\b/i.test(stmt) || /\bintent\b/i.test(stmt)) continue;
    const dd = stmt.indexOf('::');
    if (dd === -1) continue;
    const hasDimension = /\bdimension\b/i.test(stmt.slice(0, dd));
    for (let tok of stmt.slice(dd + 2).split(',')) {
      tok = tok.trim().split('=')[0].trim();
      let base = tok;
      let isArray = hasDimension;
      const arr = /^([a-zA-Z_]\w*)\s*\(/.exec(tok);
      if (arr) {
        base = arr[1];
        isArray = true;
      }
      if (!/^[a-zA-Z_]\w*$/.test(base)) continue;
      const type: ControlType =
        kind === 'character' ? 'string' :
        kind === 'logical' ? 'boolean' :
        kind === 'integer' ? 'integer' : 'real';
      const e = map.get(base);
      if (e) e.isArray = e.isArray || isArray;
      else map.set(base, { type, isArray });
    }
  }
  return map;
}

function parseNamelistDeclaration(text: string, targetName: string): string[] {
  const lines = text.split(/\r?\n/);
  const re = new RegExp('namelist\\s*/\\s*' + targetName + '\\s*/');
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let buf = stripComment(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      const l = stripComment(lines[j]).trim();
      if (!l) continue;
      buf += ' ' + l;
      if (!/&\s*$/.test(l)) break;
    }
    const names: string[] = [];
    for (const m of buf.matchAll(/\b[a-zA-Z_]\w*\b/g)) names.push(m[0]);
    return names.filter((x) => x !== 'namelist' && x !== targetName);
  }
  return [];
}

function inferType(value: string): ControlType {
  const v = value.trim();
  if (/^['"]/.test(v)) return 'string';
  if (/^\.(true|false|t|f)\.?$/i.test(v)) return 'boolean';
  if (/^[+-]?\d+$/.test(v)) return 'integer';
  return 'real';
}

function quotedTokens(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']+)'|"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const v = (m[1] || m[2] || '').trim();
    if (v && /^[a-zA-Z0-9_]+$/.test(v) && v.length <= 40) out.push(v);
  }
  return out;
}

function cleanDoc(lines: string[]): string {
  const cleaned: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (/^[~=_\-*.]{3,}$/.test(s)) continue;
    cleaned.push(s.replace(/^([+\-*])\s+/, '$1 '));
  }
  let text = cleaned.join('\n').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length > 1600) text = text.slice(0, 1600) + '…';
  return text;
}

function parseDefaultsFile(text: string, typeMap: Map<string, { type: ControlType; isArray: boolean }>): ControlDef[] {
  const controls: ControlDef[] = [];
  const byName = new Map<string, ControlDef>();
  let docLines: string[] = [];

  const controlRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\([^)]*\))?\s*=\s*([^!]*?)\s*(!.*)?$/;

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('!')) {
      const content = raw.replace(/^\s*!\s?/, '');
      if (/^={3,}\s*$/.test(content.trim())) {
        docLines = [];
        continue;
      }
      if (content.trim() === '') continue;
      docLines.push(content);
      continue;
    }

    const m = controlRe.exec(raw);
    if (m) {
      const name = m[1];
      const arrSpec = m[2] || '';
      const valueRaw = m[3].trim();
      const inlineComment = (m[4] || '').replace(/^!\s?/, '').trim();

      let type = inferType(valueRaw);
      let enums: string[] = [];
      for (const em of inlineComment.matchAll(/``([^`]+)``/g)) {
        if (/^[a-zA-Z0-9_]+$/.test(em[1].trim())) enums.push(em[1].trim());
      }
      if (type === 'string') {
        for (const line of docLines) {
          if (/^\s*[+\-*]\s+/.test(line) || ENUM_KEYWORD.test(line)) {
            enums.push(...quotedTokens(line));
          }
        }
      }

      let isArray = arrSpec.includes('(');
      const decl = typeMap.get(name);
      if (decl) {
        type = decl.type;
        isArray = isArray || decl.isArray;
      }

      const manual = MANUAL_ENUMS[name];
      if (manual) enums = enums.concat(manual);
      enums = Array.from(new Set(enums));

      // The documented default is always a valid option; keep multi-word
      // defaults (e.g. semiconvection_option = 'Langer_85 mixing; gradT = gradr').
      if (type === 'string' && enums.length > 0) {
        const dm = /^'([^']*)'$|^"([^"]*)"$/.exec(valueRaw);
        const dv = dm ? (dm[1] ?? dm[2]).trim() : '';
        if (dv !== '') enums.push(dv);
        enums = Array.from(new Set(enums));
      }

      const prev = byName.get(name);
      if (prev) {
        if (enums.length) prev.enums = Array.from(new Set([...prev.enums, ...enums]));
        prev.isArray = prev.isArray || isArray;
        docLines = [];
        continue;
      }

      const entry: ControlDef = {
        name,
        type,
        default: valueRaw,
        doc: cleanDoc(docLines),
        enums: Array.from(new Set(enums)),
        isArray,
      };
      byName.set(name, entry);
      controls.push(entry);
      docLines = [];
    }
  }
  return controls;
}

export async function rebuildFromMesaDir(mesaDir: string): Promise<MesaDefaults> {
  const typeMap = new Map<string, { type: ControlType; isArray: boolean }>();
  for (const rel of DECLARATION_FILES) {
    const p = path.join(mesaDir, rel);
    if (!fs.existsSync(p)) continue;
    for (const [k, v] of parseDeclarations(fs.readFileSync(p, 'utf8'))) {
      const e = typeMap.get(k);
      if (e) e.isArray = e.isArray || v.isArray;
      else typeMap.set(k, v);
    }
  }

  const namelists: Record<string, ControlDef[]> = {};
  let total = 0;
  for (const { namelist, files } of NAMELIST_DEFAULTS) {
    const controls: ControlDef[] = [];
    const byName = new Map<string, ControlDef>();
    for (const rel of files) {
      const p = path.join(mesaDir, rel);
      if (!fs.existsSync(p)) continue;
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

    // Merge in controls declared in the namelist statement but absent from the
    // `.defaults` files.  Skip internal pgstar bookkeeping (do_/id_/prev_).
    const declFile = NAMELIST_DECLARATIONS[namelist];
    if (declFile) {
      const p = path.join(mesaDir, declFile);
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

  return {
    version: 'custom',
    generatedAt: new Date().toISOString(),
    mesaRoot: mesaDir,
    controlCount: total,
    namelists,
  };
}

export async function reloadFromConfiguredDir(): Promise<void> {
  const c = vscode.workspace.getConfiguration('mesaInlist');
  const dir = c.get<string>('mesaDir', '');
  if (!dir) {
    void vscode.window.showWarningMessage(
      'MESA Inlist: set "mesaInlist.mesaDir" to a MESA source tree, then run this command again.'
    );
    return;
  }
  if (!fs.existsSync(path.join(dir, 'star/defaults/controls.defaults'))) {
    void vscode.window.showErrorMessage(`MESA Inlist: "${dir}" does not look like a MESA tree.`);
    return;
  }
  const db = await rebuildFromMesaDir(dir);
  setDatabase(db);
  void vscode.window.showInformationMessage(
    `MESA Inlist: loaded ${db.controlCount} controls from ${dir}.`
  );
}
