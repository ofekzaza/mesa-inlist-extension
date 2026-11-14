import * as vscode from 'vscode';
import { loadEmbedded } from './database';
import { validateDocument, readSettings, ValidationResult } from './validate';
import { MesaCompletionProvider, MesaHoverProvider } from './features';
import { reloadFromConfiguredDir } from './reload';

const LANGUAGE_ID = 'mesa-inlist';

let diagnosticCollection: vscode.DiagnosticCollection;
let invalidDecoration: vscode.TextEditorDecorationType;
const debounce = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext): void {
  // 1. Load the embedded control database (MESA 26.4).
  loadEmbedded();

  // 2. Diagnostics collection + decorations.
  diagnosticCollection = vscode.languages.createDiagnosticCollection('mesa-inlist');
  invalidDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editorError.foreground'),
  });

  // 3. Providers. Trigger characters make value completion appear automatically
  //    after `=`, `&`, quotes and the leading dot of a logical.
  const selector: vscode.DocumentSelector = { language: LANGUAGE_ID };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new MesaCompletionProvider(),
      '=',
      '&',
      "'",
      '"',
      '.'
    ),
    vscode.languages.registerHoverProvider(selector, new MesaHoverProvider())
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
        await vscode.languages.setTextDocumentLanguage(editor.document, LANGUAGE_ID);
        refreshDocument(editor.document);
      }
    })
  );

  // 5. Refresh on document change / open / settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== LANGUAGE_ID) return;
      scheduleRefresh(e.document);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId !== LANGUAGE_ID) return;
      refreshDocument(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === LANGUAGE_ID) {
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
  if (document.languageId !== LANGUAGE_ID) return;

  const result: ValidationResult = validateDocument(document, readSettings());

  // Apply diagnostics to the collection (shown in all editors for the doc).
  diagnosticCollection.set(document.uri, result.diagnostics);

  // Apply decorations to each visible editor for this document.
  const invalidRanges: vscode.Range[] = result.invalidNameRanges;
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === document.uri.toString()) {
      editor.setDecorations(invalidDecoration, invalidRanges);
    }
  }
}

function refreshAll(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId === LANGUAGE_ID) {
      refreshDocument(editor.document);
    }
  }
}

export function deactivate(): void {
  if (diagnosticCollection) diagnosticCollection.dispose();
  for (const t of debounce.values()) clearTimeout(t);
  debounce.clear();
}
