import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

interface FileRef {
  path: string;
  languageId?: string;
  isDirty?: boolean;
}

interface SelectionPayload {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text?: string;
}

interface ContextPayload {
  workspaceFolders?: string[];
  activeFile?: FileRef | null;
  openFiles?: FileRef[];
  selection?: SelectionPayload | null;
  cursor?: { path: string; line: number; column: number } | null;
  ideVersion?: string;
}

const SELECTION_CHAR_LIMIT = 64 * 1024;
const MAX_OPEN_FILES = 200;

let lastPushAt = 0;
let pending: NodeJS.Timeout | null = null;
let statusBar: vscode.StatusBarItem | null = null;

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'clawWebBridge.toggle';
  updateStatus('idle');
  statusBar.show();
  context.subscriptions.push(statusBar);

  const schedule = () => {
    const cfg = vscode.workspace.getConfiguration('clawWebBridge');
    if (!cfg.get<boolean>('enabled', true)) return;
    const throttleMs = cfg.get<number>('throttleMs', 800);
    const now = Date.now();
    const wait = Math.max(0, throttleMs - (now - lastPushAt));
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      pushNow().catch((err) => {
        console.error('[claw-web-bridge] push failed:', err);
      });
    }, wait);
  };

  // Observe events
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument(schedule),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('clawWebBridge')) updateStatus('idle');
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('clawWebBridge.pushNow', async () => {
      try {
        await pushNow(true);
        vscode.window.showInformationMessage('Claw Web: pushed editor state');
      } catch (err) {
        vscode.window.showErrorMessage(`Claw Web: push failed — ${err instanceof Error ? err.message : err}`);
      }
    }),
    vscode.commands.registerCommand('clawWebBridge.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('clawWebBridge');
      const cur = cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', !cur, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Claw Web Bridge ${!cur ? 'enabled' : 'disabled'}`);
      updateStatus('idle');
    })
  );

  // Initial push
  schedule();
}

export function deactivate() {
  if (pending) clearTimeout(pending);
  pending = null;
  statusBar?.dispose();
}

function updateStatus(state: 'idle' | 'ok' | 'error' | 'off') {
  if (!statusBar) return;
  const cfg = vscode.workspace.getConfiguration('clawWebBridge');
  if (!cfg.get<boolean>('enabled', true)) state = 'off';
  const icons: Record<typeof state, string> = {
    idle: '$(cloud) Claw',
    ok: '$(cloud-upload) Claw',
    error: '$(warning) Claw',
    off: '$(circle-slash) Claw'
  };
  statusBar.text = icons[state];
  statusBar.tooltip = 'Claw Web Bridge — click to toggle';
}

async function pushNow(forced = false): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('clawWebBridge');
  if (!forced && !cfg.get<boolean>('enabled', true)) return;

  const endpoint = cfg.get<string>('endpoint', 'http://localhost:3838').replace(/\/$/, '');
  const token = cfg.get<string>('authToken', '');
  const includeSelText = cfg.get<boolean>('includeSelectionText', true);

  const payload = buildPayload(includeSelText);
  lastPushAt = Date.now();

  try {
    await postJson(`${endpoint}/api/bridge/context`, payload, token);
    updateStatus('ok');
  } catch (err) {
    updateStatus('error');
    throw err;
  }
}

function buildPayload(includeSelText: boolean): ContextPayload {
  const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const activeEditor = vscode.window.activeTextEditor;

  const active: FileRef | null = activeEditor
    ? {
        path: activeEditor.document.uri.fsPath,
        languageId: activeEditor.document.languageId,
        isDirty: activeEditor.document.isDirty
      }
    : null;

  const seen = new Set<string>();
  const openFiles: FileRef[] = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isUntitled) continue;
    if (doc.uri.scheme !== 'file') continue;
    const p = doc.uri.fsPath;
    if (seen.has(p)) continue;
    seen.add(p);
    openFiles.push({ path: p, languageId: doc.languageId, isDirty: doc.isDirty });
    if (openFiles.length >= MAX_OPEN_FILES) break;
  }

  let selection: SelectionPayload | null = null;
  let cursor: { path: string; line: number; column: number } | null = null;
  if (activeEditor) {
    const sel = activeEditor.selection;
    cursor = { path: activeEditor.document.uri.fsPath, line: sel.active.line, column: sel.active.character };
    if (!sel.isEmpty) {
      const rawText = activeEditor.document.getText(sel);
      selection = {
        path: activeEditor.document.uri.fsPath,
        startLine: sel.start.line,
        startColumn: sel.start.character,
        endLine: sel.end.line,
        endColumn: sel.end.character,
        ...(includeSelText ? { text: rawText.slice(0, SELECTION_CHAR_LIMIT) } : {})
      };
    }
  }

  return {
    workspaceFolders: folders,
    activeFile: active,
    openFiles,
    selection,
    cursor,
    ideVersion: `vscode/${vscode.version}`
  };
}

function postJson(urlStr: string, body: unknown, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body));
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}
