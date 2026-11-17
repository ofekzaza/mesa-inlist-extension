import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MesaDefaults, ControlDef, MesaColumns, ColumnEntry } from './types';

let database: MesaDefaults | null = null;
/** Per-namelist index: namelist -> control name -> definition. */
const byNamelist = new Map<string, Map<string, ControlDef>>();
/** Global index: control name -> all namelists that contain it. */
const locations = new Map<string, string[]>();

// --- columns database (history_columns.list / profile_columns.list) ---
let columnsDb: MesaColumns | null = null;
const columnEntries = new Map<string, ColumnEntry[]>(); // 'history'|'profile' -> entries
const columnPrefixes = new Map<string, string[]>(); // 'history'|'profile' -> prefixes

/** Load the embedded database (bundled at build time). */
export function loadEmbedded(): void {
  const file = path.join(__dirname, '..', 'data', 'mesa-defaults.json');
  if (!fs.existsSync(file)) {
    void vscode.window.showErrorMessage(
      'MESA Inlist: embedded database not found at ' + file
    );
    return;
  }
  const raw = fs.readFileSync(file, 'utf8');
  setDatabase(JSON.parse(raw) as MesaDefaults);
}

/** Load the embedded columns database (history/profile columns). */
export function loadColumnsEmbedded(): void {
  const file = path.join(__dirname, '..', 'data', 'mesa-columns.json');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  setColumnsDatabase(JSON.parse(raw) as MesaColumns);
}

/** Replace the in-memory database and rebuild the lookup indexes. */
export function setDatabase(db: MesaDefaults): void {
  database = db;
  byNamelist.clear();
  locations.clear();
  for (const [namelist, controls] of Object.entries(db.namelists)) {
    const map = new Map<string, ControlDef>();
    for (const control of controls) {
      // Fortran namelist control names are case-insensitive.
      map.set(control.name.toLowerCase(), control);
      const key = control.name.toLowerCase();
      const loc = locations.get(key);
      if (loc) loc.push(namelist);
      else locations.set(key, [namelist]);
    }
    byNamelist.set(namelist, map);
  }
}

export function getDatabase(): MesaDefaults | null {
  return database;
}

/** All controls for a given namelist section. */
export function getControls(namelist: string): ControlDef[] {
  return database?.namelists[namelist] ?? [];
}

/** Look up a control within a specific namelist (case-insensitive). */
export function getControl(namelist: string, name: string): ControlDef | undefined {
  return byNamelist.get(namelist)?.get(name.toLowerCase());
}

/** All namelists that contain a control of this name (case-insensitive). */
export function findNamelists(name: string): string[] {
  return locations.get(name.toLowerCase()) ?? [];
}

/** List of known namelist section names. */
export function getNamelists(): string[] {
  return database ? Object.keys(database.namelists) : [];
}

export function isKnownNamelist(name: string): boolean {
  return byNamelist.has(name);
}

/** Replace the in-memory columns database and rebuild indexes. */
export function setColumnsDatabase(db: MesaColumns): void {
  columnsDb = db;
  columnEntries.clear();
  columnPrefixes.clear();
  for (const type of ['history', 'profile'] as const) {
    columnEntries.set(type, db[type]);
  }
  columnPrefixes.set('history', db.historyPrefixes ?? []);
  columnPrefixes.set('profile', db.profilePrefixes ?? []);
}

export type ColumnFileType = 'history' | 'profile' | 'both';

/** A name is valid if it is a known column, or matches a prefix pattern. */
function matchesPrefix(type: 'history' | 'profile', name: string): boolean {
  return (columnPrefixes.get(type) ?? []).some((p) => name.startsWith(p));
}

export function isKnownColumn(type: ColumnFileType, name: string): boolean {
  if (type === 'both') {
    return (
      !!columnEntries.get('history')?.find((e) => e.name === name) ||
      !!columnEntries.get('profile')?.find((e) => e.name === name) ||
      matchesPrefix('history', name) ||
      matchesPrefix('profile', name)
    );
  }
  return (
    !!columnEntries.get(type)?.find((e) => e.name === name) || matchesPrefix(type, name)
  );
}

/** Look up a column's full entry (name, kind, description). */
export function getColumnInfo(type: ColumnFileType, name: string): ColumnEntry | undefined {
  const lookup = (t: 'history' | 'profile') =>
    columnEntries.get(t)?.find((e) => e.name === name);
  if (type === 'both') return lookup('history') ?? lookup('profile');
  return lookup(type);
}

export function getColumnEntries(type: 'history' | 'profile'): ColumnEntry[] {
  return columnEntries.get(type) ?? [];
}
