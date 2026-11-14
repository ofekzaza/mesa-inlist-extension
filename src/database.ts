import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MesaDefaults, ControlDef } from './types';

let database: MesaDefaults | null = null;
/** Per-namelist index: namelist -> control name -> definition. */
const byNamelist = new Map<string, Map<string, ControlDef>>();
/** Global index: control name -> all namelists that contain it. */
const locations = new Map<string, string[]>();

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
