import * as vscode from 'vscode';
import { parse, inferValueType, unquote, isIntegralReal, splitValueList, ParsedDoc } from './parser';
import { getControl, isKnownNamelist, findNamelists } from './database';
import { ControlDef } from './types';

export interface ValidationSettings {
  reportUnknownControls: boolean;
  reportUnknownNamelists: boolean;
  enableValueTypeChecking: boolean;
  enableEnumChecking: boolean;
}

export interface ValidationResult {
  diagnostics: vscode.Diagnostic[];
  /** Ranges (of control names) that should be highlighted red. */
  invalidNameRanges: vscode.Range[];
}

export function readSettings(): ValidationSettings {
  const c = vscode.workspace.getConfiguration('mesaInlist');
  return {
    reportUnknownControls: c.get<boolean>('reportUnknownControls', true),
    reportUnknownNamelists: c.get<boolean>('reportUnknownNamelists', false),
    enableValueTypeChecking: c.get<boolean>('enableValueTypeChecking', true),
    enableEnumChecking: c.get<boolean>('enableEnumChecking', true),
  };
}

export function validateDocument(
  document: vscode.TextDocument,
  settings: ValidationSettings
): ValidationResult {
  const doc: ParsedDoc = parse(document.getText());
  const diagnostics: vscode.Diagnostic[] = [];
  const invalidNameRanges: vscode.Range[] = [];

  for (const a of doc.assignments) {
    const nameRange = new vscode.Range(
      document.positionAt(a.nameRange[0]),
      document.positionAt(a.nameRange[1])
    );

    // Assignments outside any namelist section are not validated.
    if (!a.namelist) continue;

    // Unknown (likely custom) namelist: optionally warn, then skip contents.
    if (!isKnownNamelist(a.namelist)) {
      if (settings.reportUnknownNamelists) {
        // Report once per section (we only have the assignment here, so report per line).
        diagnostics.push(
          new vscode.Diagnostic(
            nameRange,
            `Unknown namelist section "&${a.namelist}".`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      continue;
    }

    const hit = getControl(a.namelist, a.baseName);
    if (!hit) {
      const locs = findNamelists(a.baseName);
      if (locs.length > 0) {
        diagnostics.push(
          new vscode.Diagnostic(
            nameRange,
            `"${a.baseName}" does not belong to &${a.namelist}; it is a control of &${locs[0]}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        invalidNameRanges.push(nameRange);
      } else if (settings.reportUnknownControls) {
        diagnostics.push(
          new vscode.Diagnostic(
            nameRange,
            `Unknown control "${a.baseName}" in &${a.namelist}.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        invalidNameRanges.push(nameRange);
      }
      continue;
    }

    // The control is valid; validate its value if requested.
    if (settings.enableValueTypeChecking) {
      checkValue(a, hit, document, diagnostics, nameRange, invalidNameRanges);
    }
  }

  return { diagnostics, invalidNameRanges };
}

function checkValue(
  a: import('./parser').Assignment,
  def: ControlDef,
  document: vscode.TextDocument,
  diagnostics: vscode.Diagnostic[],
  nameRange: vscode.Range,
  invalidNameRanges: vscode.Range[]
): void {
  const valueRange = new vscode.Range(
    document.positionAt(a.valueRange[0]),
    document.positionAt(a.valueRange[1])
  );

  const expectedLabel =
    def.type === 'boolean' ? 'a logical (.true./.false.)' :
    def.type === 'integer' ? 'an integer' :
    def.type === 'real' ? 'a real number' : 'a string (quoted)';

  // Array controls may be set with a comma-separated list of values.
  const parts = splitValueList(a.value);
  for (const part of parts) {
    const vt = inferValueType(part);
    let ok = true;
    switch (def.type) {
      case 'boolean':
        ok = vt === 'boolean';
        break;
      case 'integer':
        ok = vt === 'integer' || (vt === 'real' && isIntegralReal(part));
        break;
      case 'real':
        ok = vt === 'integer' || vt === 'real';
        break;
      case 'string':
        ok = vt === 'string';
        break;
    }
    if (!ok) {
      const d = new vscode.Diagnostic(
        valueRange,
        `"${a.baseName}" expects ${expectedLabel}, got "${part}".`,
        vscode.DiagnosticSeverity.Error
      );
      d.source = 'mesa-inlist';
      diagnostics.push(d);
      invalidNameRanges.push(nameRange);
      return;
    }
  }

  if (def.type === 'string') {
    checkEnums(a, def, document, diagnostics, parts);
  }
}

function checkEnums(
  a: import('./parser').Assignment,
  def: ControlDef,
  document: vscode.TextDocument,
  diagnostics: vscode.Diagnostic[],
  parts: string[]
): void {
  if (!def.enums || def.enums.length === 0) return;

  for (const part of parts) {
    const inner = unquote(part);
    if (inner === null || inner === '') continue;
    if (def.enums.includes(inner)) continue;

    const valueRange = new vscode.Range(
      document.positionAt(a.valueRange[0]),
      document.positionAt(a.valueRange[1])
    );
    const d = new vscode.Diagnostic(
      valueRange,
      `"${inner}" is not one of the documented options for "${a.baseName}": ${def.enums
        .map((e) => `'${e}'`)
        .join(', ')}.`,
      vscode.DiagnosticSeverity.Warning
    );
    d.source = 'mesa-inlist';
    diagnostics.push(d);
    return;
  }
}
