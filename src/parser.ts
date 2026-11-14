export type ValueType = 'boolean' | 'integer' | 'real' | 'string' | 'unknown';

export interface Assignment {
  /** Raw control name as written, including any array index, e.g. "xa(1)". */
  name: string;
  /** Control name without the array index, e.g. "xa". */
  baseName: string;
  /** The array index text (without parentheses), or null. */
  index: string | null;
  /** Raw value text as written (trimmed). */
  value: string;
  /** The namelist section this assignment appears in (null if none). */
  namelist: string | null;
  /** Character offsets [start, end) of the control name (without index). */
  nameRange: [number, number];
  /** Character offsets [start, end) of the value. */
  valueRange: [number, number];
  /** 0-based line number. */
  line: number;
}

export interface Section {
  name: string;
  line: number;
  nameRange: [number, number];
}

export interface ParsedDoc {
  sections: Section[];
  assignments: Assignment[];
}

const NAMELIST_OPEN = /^\s*&\s*([a-zA-Z_][a-zA-Z0-9_]*)/;
const NAMELIST_CLOSE = /^\s*\//;
const ASSIGNMENT =
  /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\([^)]*\))?\s*=\s*([^!]*?)(\s*!.*)?$/;

export function inferValueType(value: string): ValueType {
  const v = value.trim();
  if (v === '') return 'unknown';
  if (/^['"]/.test(v)) return 'string';
  if (/^\.(true|false|t|f)\.?$/i.test(v)) return 'boolean';
  if (/^[+-]?\d+$/.test(v)) return 'integer';
  if (/^[+-]?(?:\d+\.\d*(?:[dDeE][+-]?\d+)?|\d+[dDeE][+-]?\d+|\.\d+(?:[dDeE][+-]?\d+)?)$/.test(v)) {
    return 'real';
  }
  return 'unknown';
}

/**
 * Parse a MESA inlist document (Fortran namelist format) into sections and
 * assignments with character offsets suitable for diagnostics/decorations.
 */
export function parse(text: string): ParsedDoc {
  const sections: Section[] = [];
  const assignments: Assignment[] = [];
  let currentNamelist: string | null = null;

  const rawLines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('!')) {
      // comment or blank: nothing to do
    } else {
      const open = NAMELIST_OPEN.exec(line);
      if (open) {
        currentNamelist = open[1];
        const idx = line.indexOf(open[1]);
        sections.push({
          name: open[1],
          line: i,
          nameRange: [offset + idx, offset + idx + open[1].length],
        });
      } else if (NAMELIST_CLOSE.test(line)) {
        currentNamelist = null;
      } else {
        const am = ASSIGNMENT.exec(line);
        if (am) {
          const name = am[1];
          const indexSpec = am[2] || '';
          const value = am[3].trim();

          const nameIdx = line.indexOf(name);
          const nameStart = offset + nameIdx;
          const nameEnd = nameStart + name.length;
          const index = indexSpec ? indexSpec.slice(1, -1).trim() : null;

          // Locate the value (first non-space char after the `=`).
          const eqIdx = line.indexOf('=', nameEnd - offset);
          let valueStart = eqIdx + 1;
          while (valueStart < line.length && /\s/.test(line[valueStart])) valueStart++;
          let valueEnd = valueStart + value.length;

          assignments.push({
            name: name + (indexSpec || ''),
            baseName: name,
            index,
            value,
            namelist: currentNamelist,
            nameRange: [nameStart, nameEnd],
            valueRange: [offset + valueStart, offset + valueEnd],
            line: i,
          });
        }
      }
    }

    offset += raw.length + 1;
  }

  return { sections, assignments };
}

/** Unquote a Fortran string literal, returning the inner text (or null). */
export function unquote(value: string): string | null {
  const v = value.trim();
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replace(/""/g, '"');
  }
  return null;
}

/** True if the string is a numeric literal that represents a whole number. */
export function isIntegralReal(value: string): boolean {
  const n = Number(value.replace(/[dD]/g, 'e'));
  return Number.isFinite(n) && Number.isInteger(n);
}

/**
 * Split a value on top-level commas (ignoring commas inside quotes or
 * parentheses).  MESA array controls can be set with a comma-separated list,
 * e.g. `user_kap_Xs = 0.0d0, 0.1d0, 0.2d0`.
 */
export function splitValueList(value: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inS = false;
  let inD = false;
  let depth = 0;
  for (const ch of value) {
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}
