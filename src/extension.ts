import * as vscode from 'vscode';
import { loadEmbedded, loadColumnsEmbedded } from './database';
import { validateDocument, readSettings, ValidationResult } from './validate';
import { MesaCompletionProvider, MesaHoverProvider } from './features';
import {
  validateColumnsDocument,
  MesaColumnsCompletionProvider,
  MesaColumnsHoverProvider,
} from './columns';
import { reloadFromConfiguredDir } from './reload';

const INLIST_LANG = 'mesa-inlist';
const COLUMNS_LANG = 'mesa-columns';
const SUPPORTED_LANGS = new Set([INLIST_LANG, COLUMNS_LANG]);

let diagnosticCollection: vscode.DiagnosticCollection;
let invalidDecoration: vscode.TextEditorDecorationType;
const debounce = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext): void {
  // 1. Load the embedded control + columns databases (MESA 26.4).
  loadEmbedded();
  loadColumnsEmbedded();

  // 2. Diagnostics collection + decorations.
  diagnosticCollection = vscode.languages.createDiagnosticCollection('mesa-inlist');
  invalidDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editorError.foreground'),
  });

  // 3. Providers. Trigger characters make value completion appear automatically
  //    after `=`, `&`, quotes and the leading dot of a logical.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: INLIST_LANG },
      new MesaCompletionProvider(),
      '=',
      '&',
      "'",
      '"',
      '.'
    ),
    vscode.languages.registerHoverProvider({ language: INLIST_LANG }, new MesaHoverProvider()),
    vscode.languages.registerCompletionItemProvider(
      { language: COLUMNS_LANG },
      new MesaColumnsCompletionProvider()
    ),
    vscode.languages.registerHoverProvider(
      { language: COLUMNS_LANG },
      new MesaColumnsHoverProvider()
    )
  );

  // 4. Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('mesaInlist.reloadDefaults', async () => {
      await reloadFromConfiguredDir();
      refreshAll();
    }),
    vscode.commands.registerCommand('mesaInlist.setLanguage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await vscode.languages.setTextDocumentLanguage(editor.document, INLIST_LANG);
        refreshDocument(editor.document);
      }
    })
  );

  // 5. Refresh on document change / open / settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!SUPPORTED_LANGS.has(e.document.languageId)) return;
      scheduleRefresh(e.document);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!SUPPORTED_LANGS.has(doc.languageId)) return;
      refreshDocument(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && SUPPORTED_LANGS.has(editor.document.languageId)) {
        refreshDocument(editor.document);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mesaInlist')) refreshAll();
    })
  );

  // Initial pass over already-open editors.
  refreshAll();
}

function scheduleRefresh(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = debounce.get(key);
  if (existing) clearTimeout(existing);
  debounce.set(
    key,
    setTimeout(() => {
      debounce.delete(key);
      refreshDocument(document);
    }, 150)
  );
}

function refreshDocument(document: vscode.TextDocument): void {
  try {
    let result: ValidationResult;

    if (document.languageId === COLUMNS_LANG) {
      result = validateColumnsDocument(document);
    } else if (document.languageId === INLIST_LANG) {
      result = validateDocument(document, readSettings());
    } else {
      return;
    }

    diagnosticCollection.set(document.uri, result.diagnostics);

    const invalidRanges = result.invalidNameRanges;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === document.uri.toString()) {
        editor.setDecorations(invalidDecoration, invalidRanges);
      }
    }
  } catch (err) {
    console.error('mesa-inlist: refresh failed', err);
  }
}

function refreshAll(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (SUPPORTED_LANGS.has(editor.document.languageId)) {
      refreshDocument(editor.document);
    }
  }
}

export function deactivate(): void {
  if (diagnosticCollection) diagnosticCollection.dispose();
  for (const t of debounce.values()) clearTimeout(t);
  debounce.clear();
}
