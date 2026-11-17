import * as vscode from 'vscode';
import { isKnownColumn, getColumnInfo, getColumnEntries, ColumnFileType } from './database';
import { ColumnEntry } from './types';

/**
 * Support for MESA `history_columns.list` / `profile_columns.list` files:
 * highlight valid columns, red-mark unknown ones, and offer completion + hover.
 */

export interface ColumnLine {
  name: string;
  nameRange: [number, number];
  line: number;
  commentedOut: boolean;
  /** Text after the name on the same line (for argument checks). */
  tail: string;
}

export function parseColumnsFile(text: string): ColumnLine[] {
  const out: ColumnLine[] = [];
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '') {
      offset += raw.length + 1;
      continue;
    }

    let rest = trimmed;
    let commentedOut = false;
    if (rest.startsWith('!')) {
      const after = rest.slice(1);
      // A `!` immediately followed by an identifier (no space) is a commented-out
      // column; a `! ` (space) or `!#` is a prose comment / section header.
      if (!/^[a-zA-Z_]/.test(after)) {
        offset += raw.length + 1;
        continue;
      }
      rest = after;
      commentedOut = true;
    }

    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(.*)$/.exec(rest);
    if (!m) {
      offset += raw.length + 1;
      continue;
    }
    const name = m[1];
    const tail = m[2].trim();
    const idx = line.indexOf(name);
    out.push({
      name,
      nameRange: [offset + idx, offset + idx + name.length],
      line: i,
      commentedOut,
      tail,
    });
    offset += raw.length + 1;
  }
  return out;
}

/** Determine whether a document is a history or profile columns file. */
export function columnFileType(document: vscode.TextDocument): ColumnFileType {
  const base = document.fileName.toLowerCase();
  if (base.includes('profile')) return 'profile';
  if (base.includes('history')) return 'history';
  return 'both';
}

function kindLabel(kind: ColumnEntry['kind']): string {
  switch (kind) {
    case 'directive':
      return 'directive (adds many columns)';
    case 'argcolumn':
      return 'column — takes an integer argument';
    default:
      return 'column';
  }
}

function columnDoc(info: ColumnEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.appendMarkdown(`\`${info.name}\` — ${kindLabel(info.kind)}`);
  if (info.desc) md.appendMarkdown('\n\n' + info.desc);
  return md;
}

export interface ColumnsValidationResult {
  diagnostics: vscode.Diagnostic[];
  invalidNameRanges: vscode.Range[];
}

export function validateColumnsDocument(
  document: vscode.TextDocument
): ColumnsValidationResult {
  const type = columnFileType(document);
  const diagnostics: vscode.Diagnostic[] = [];
  const invalidNameRanges: vscode.Range[] = [];

  for (const e of parseColumnsFile(document.getText())) {
    const range = new vscode.Range(
      document.positionAt(e.nameRange[0]),
      document.positionAt(e.nameRange[1])
    );
    if (!isKnownColumn(type, e.name)) {
      const d = new vscode.Diagnostic(
        range,
        `Unknown column "${e.name}".`,
        vscode.DiagnosticSeverity.Error
      );
      d.source = 'mesa-inlist';
      diagnostics.push(d);
      invalidNameRanges.push(range);
      continue;
    }

    const info = getColumnInfo(type, e.name);
    if (info?.kind === 'argcolumn' && !e.commentedOut) {
      // `mixing_regions`, `burning_regions`, ... must be followed by an integer.
      if (!/^\d+\s*/.test(e.tail)) {
        const d = new vscode.Diagnostic(
          range,
          `"${e.name}" expects an integer argument (e.g. "${e.name} 10").`,
          vscode.DiagnosticSeverity.Warning
        );
        d.source = 'mesa-inlist';
        diagnostics.push(d);
      }
    }
  }

  return { diagnostics, invalidNameRanges };
}

export class MesaColumnsCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const type = columnFileType(document);
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_]/);
    const prefix = wordRange ? document.getText(wordRange).toLowerCase() : '';

    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    const push = (info: ColumnEntry) => {
      if (seen.has(info.name)) return;
      if (prefix && !info.name.toLowerCase().startsWith(prefix)) return;
      seen.add(info.name);

      const kind =
        info.kind === 'directive'
          ? vscode.CompletionItemKind.Keyword
          : vscode.CompletionItemKind.Field;
      const item = new vscode.CompletionItem(info.name, kind);
      item.detail = kindLabel(info.kind);
      item.documentation = columnDoc(info);
      item.sortText = info.name;
      item.insertText =
        info.name === 'include'
          ? new vscode.SnippetString("include '${1:filename}'")
          : info.name;
      items.push(item);
    };

    const lists: ('history' | 'profile')[] = type === 'both' ? ['history', 'profile'] : [type];
    for (const t of lists) {
      for (const info of getColumnEntries(t)) push(info);
    }
    return items;
  }
}

export class MesaColumnsHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const type = columnFileType(document);
    for (const e of parseColumnsFile(document.getText())) {
      if (
        position.isAfterOrEqual(document.positionAt(e.nameRange[0])) &&
        position.isBeforeOrEqual(document.positionAt(e.nameRange[1]))
      ) {
        const info = getColumnInfo(type, e.name);
        if (info) return new vscode.Hover(columnDoc(info));
        return new vscode.Hover(
          new vscode.MarkdownString(`\`${e.name}\` is not a known MESA column.`)
        );
      }
    }
    return undefined;
  }
}
