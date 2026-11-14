import * as vscode from 'vscode';
import { parse, inferValueType, unquote } from './parser';
import { getControl, getControls, getNamelists } from './database';
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
  return def.isArray ? `${def.type}[]` : def.type;
}

function docMarkdown(def: ControlDef, namelist?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = false;

  const header =
    `\`${def.name}\` — \`${typeLabel(def)}\`` +
    (namelist ? ` in \`&${namelist}\`` : '');
  md.appendMarkdown(header);
  if (def.default !== undefined && def.default !== '') {
    md.appendMarkdown(`\n\n**Default:** \`${def.default}\``);
  }
  if (def.enums && def.enums.length > 0) {
    md.appendMarkdown(`\n\n**Options:** ${def.enums.map((e) => `\`'${e}'\``).join(', ')}`);
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
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, position.character);

    // 1) Namelist-section completion, right after `&`.
    if (/^\s*&[a-zA-Z_]*$/.test(before)) {
      return this.namelistCompletions();
    }

    const namelist = namelistAtPosition(document.getText(), position);

    // 2) Value completion, after `name = `.
    if (namelist && /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(?:\([^)]*\))?\s*=\s*.*$/.test(before)) {
      return this.valueCompletions(document, position, namelist, line);
    }

    // 3) Control-name completion (cross-section aware).
    return this.controlCompletions(document, position, namelist);
  }

  private currentWord(document: vscode.TextDocument, position: vscode.Position): string {
    const range = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_]/);
    return range ? document.getText(range) : '';
  }

  private namelistCompletions(): vscode.CompletionItem[] {
    return getNamelists().map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
      item.detail = `namelist section (&${name})`;
      item.insertText = name;
      const count = getControls(name).length;
      item.documentation = new vscode.MarkdownString(
        `\`&${name}\` namelist section — ${count} controls available.`
      );
      item.sortText = '0' + name;
      return item;
    });
  }

  private controlItem(def: ControlDef, section: string, isCurrent: boolean): vscode.CompletionItem {
    const item = new vscode.CompletionItem(def.name, vscode.CompletionItemKind.Field);
    item.detail = isCurrent
      ? `${typeLabel(def)}  =  ${def.default || ''}`
      : `${typeLabel(def)}  =  ${def.default || ''}   [&${section}]`;
    item.documentation = docMarkdown(def, section);
    item.insertText = def.name;
    // Current-section matches rank first, then alphabetical by name.
    item.sortText = (isCurrent ? '0' : '1') + def.name;
    return item;
  }

  private controlCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    namelist: string | null
  ): vscode.CompletionItem[] {
    const prefix = this.currentWord(document, position);

    // No word being typed yet: show the current section's controls (or the
    // available namelist sections when outside a section).
    if (prefix === '') {
      if (namelist) {
        return getControls(namelist).map((def) => this.controlItem(def, namelist, true));
      }
      return this.namelistCompletions();
    }

    // Otherwise: prefix-match controls across all namelists, tagging each with
    // its section so `stop_*`, `max_*`, `MLT_option`, ... are always findable.
    const lower = prefix.toLowerCase();
    const items: vscode.CompletionItem[] = [];
    for (const section of getNamelists()) {
      const isCurrent = section === namelist;
      for (const def of getControls(section)) {
        if (def.name.toLowerCase().startsWith(lower)) {
          items.push(this.controlItem(def, section, isCurrent));
        }
      }
    }
    return items;
  }

  private valueCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    namelist: string,
    line: string
  ): vscode.CompletionItem[] {
    const before = line.slice(0, position.character);
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*=\s*(.*)$/.exec(before);
    if (!m) return [];
    const baseName = m[1];
    const prefix = m[2];
    const def = getControl(namelist, baseName);
    if (!def) return [];

    // Replace everything from the start of the value up to the cursor.
    const eqIdx = line.indexOf('=');
    let valueStart = eqIdx + 1;
    while (valueStart < line.length && /\s/.test(line[valueStart])) valueStart++;
    const range = new vscode.Range(position.line, valueStart, position.line, position.character);

    const items: vscode.CompletionItem[] = [];
    const add = (text: string, detail: string) => {
      if (text.startsWith(prefix)) {
        const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Value);
        item.detail = detail;
        item.insertText = text;
        item.range = range;
        items.push(item);
      }
    };

    if (def.type === 'boolean') {
      add('.true.', 'logical');
      add('.false.', 'logical');
    } else if (def.type === 'string') {
      for (const e of def.enums) add(`'${e}'`, `option for ${def.name}`);
      if (def.enums.length === 0) add(`''`, 'empty string');
      else if (def.default) add(def.default, `default for ${def.name}`);
    } else {
      // real / integer: offer the default value as a convenience.
      if (def.default) add(def.default, `default for ${def.name}`);
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
