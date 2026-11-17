export type ControlType = 'boolean' | 'integer' | 'real' | 'string';

export interface ControlDef {
  name: string;
  type: ControlType;
  default: string;
  doc: string;
  enums: string[];
  isArray: boolean;
}

export interface MesaDefaults {
  version: string;
  generatedAt: string;
  mesaRoot: string;
  controlCount: number;
  namelists: Record<string, ControlDef[]>;
}

export type ColumnKind = 'column' | 'directive' | 'argcolumn';

export interface ColumnEntry {
  name: string;
  kind: ColumnKind;
  desc: string;
}

export interface MesaColumns {
  version: string;
  generatedAt: string;
  history: ColumnEntry[];
  profile: ColumnEntry[];
  historyPrefixes: string[];
  profilePrefixes: string[];
}
