import * as vscode from 'vscode';
import { parse, inferValueType, unquote } from './parser';
import { getControl, getControls } from './database';
import { ControlDef } from './types';

/**
 * Find the namelist section active at a given position by scanning backwards.
 */
export function namelistAtPosition(text: string, position: vscode.Position): string | null {
  const lines = text.split('\n');
  let current: string | null = null;
  const limit = Math.min(position.line, lines.length - 1);
  for (let i = 0; i <= limit; i++) {
    const line = lines[i].replace(/\r$/, '');
    const open = /^\s*&\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(line);
    if (open) current = open[1];
    else if (/^\s*\//.test(line)) current = null;
  }
  return current;
}

function typeLabel(def: ControlDef): string {
  const arr = def.isArray ? '[]' : '';
  return `${def.type}${arr}`;
}

function docMarkdown(def: ControlDef, namelist?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;

  const header = `\`${def.name}\` — \`${typeLabel(def)}\`` + (namelist ? ` in \`&${namelist}\`` : '');
  md.appendMarkdown(header);
  if (def.default !== undefined && def.default !== '') {
    md.appendMarkdown(`\n\n**Default:** \`${def.default}\``);
  }
  if (def.enums && def.enums.length > 0) {
    md.appendMarkdown(
      `\n\n**Options:** ${def.enums.map((e) => `\`'${e}'\``).join(', ')}`
    );
  }
  if (def.doc) {
    md.appendMarkdown('\n\n---\n\n' + def.doc);
  }
  return md;
}

export class MesaCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const text = document.getText();
    const namelist = namelistAtPosition(text, position);
    if (!namelist) return [];

    const line = document.lineAt(position.line).text;
    const beforeCursor = line.slice(0, position.character);

    // Are we on the right-hand side of an assignment?
    const rhs = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(\([^)]*\))?\s*=\s*/.exec(beforeCursor);
    if (rhs) {
      return this.valueCompletions(document, position, namelist, line, beforeCursor);
    }

    return this.controlCompletions(namelist);
  }

  private controlCompletions(namelist: string): vscode.CompletionItem[] {
    const controls = getControls(namelist);
    return controls.map((def) => {
      const item = new vscode.CompletionItem(def.name, vscode.CompletionItemKind.Field);
      item.detail = `${typeLabel(def)} = ${def.default}`;
      item.documentation = docMarkdown(def, namelist);
      item.sortText = def.name;
      return item;
    });
  }

  private valueCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    namelist: string,
    line: string,
    beforeCursor: string
  ): vscode.CompletionItem[] {
    // Determine which control we are completing a value for.
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*=\s*(.*)$/.exec(beforeCursor);
    if (!m) return [];
    const baseName = m[1];
    const typed = m[2].trim();
    const def = getControl(namelist, baseName);
    if (!def) return [];

    const prefix = typed;
    const items: vscode.CompletionItem[] = [];

    if (def.type === 'boolean') {
      for (const b of ['.true.', '.false.']) {
        if (b.startsWith(prefix)) {
          const item = new vscode.CompletionItem(b, vscode.CompletionItemKind.Value);
          item.detail = 'logical';
          items.push(item);
        }
      }
    } else if (def.type === 'string') {
      if (def.enums && def.enums.length > 0) {
        for (const e of def.enums) {
          const val = `'${e}'`;
          if (val.startsWith(prefix)) {
            const item = new vscode.CompletionItem(val, vscode.CompletionItemKind.Value);
            item.detail = `option for ${def.name}`;
            items.push(item);
          }
        }
      }
      const empty = `''`;
      if (empty.startsWith(prefix) && items.length === 0) {
        const item = new vscode.CompletionItem(empty, vscode.CompletionItemKind.Value);
        item.detail = 'empty string';
        items.push(item);
      }
    }

    return items;
  }
}

export class MesaHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const doc = parse(document.getText());

    // Prefer a hover over a control name first.
    for (const a of doc.assignments) {
      if (
        position.isAfterOrEqual(document.positionAt(a.nameRange[0])) &&
        position.isBeforeOrEqual(document.positionAt(a.nameRange[1]))
      ) {
        const hit = a.namelist ? getControl(a.namelist, a.baseName) : undefined;
        if (hit) {
          return new vscode.Hover(docMarkdown(hit, a.namelist ?? undefined));
        }
        // Unknown control
        return new vscode.Hover(
          new vscode.MarkdownString(`\`${a.baseName}\` is not a known MESA control.`)
        );
      }
    }

    // Otherwise hover over a value.
    for (const a of doc.assignments) {
      if (
        position.isAfterOrEqual(document.positionAt(a.valueRange[0])) &&
        position.isBeforeOrEqual(document.positionAt(a.valueRange[1]))
      ) {
        const def = a.namelist ? getControl(a.namelist, a.baseName) : undefined;
        if (!def) return undefined;
        const vt = inferValueType(a.value);
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`\`${a.value}\``);
        md.appendMarkdown(`\n\nType: \`${def.type}\``);
        if (def.type === 'string' && def.enums.length > 0) {
          md.appendMarkdown(
            `\n\nOptions: ${def.enums.map((e) => `\`'${e}'\``).join(', ')}`
          );
          const inner = unquote(a.value);
          if (inner && !def.enums.includes(inner)) {
            md.appendMarkdown(`\n\n⚠ \`'${inner}'\` is not a documented option.`);
          }
        }
        return new vscode.Hover(md);
      }
    }

    return undefined;
  }
}
