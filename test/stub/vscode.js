// Stub minimo de la API de VS Code, suficiente para cargar y activar la extension.
const noop = () => {};
const registered = [];
class EventEmitter { constructor(){this.event=()=>({dispose:noop});} fire(){} }
class TreeItem { constructor(l,c){this.label=l;this.collapsibleState=c;} }
class ThemeIcon { constructor(id){this.id=id;} }
class ThemeColor { constructor(id){this.id=id;} }
class MarkdownString { constructor(v){this.value=v;} }
module.exports = {
  EventEmitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString,
  TreeItemCollapsibleState: { None: 0 },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { Beside: -2 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  Uri: { parse: (s) => ({ toString: () => s }) },
  env: { openExternal: noop, clipboard: { writeText: noop } },
  commands: {
    registerCommand: (id, fn) => { registered.push(id); return { dispose: noop }; },
    getCommands: async () => module.exports.__available,
    executeCommand: async (id) => {
      if (module.exports.__failCommands.includes(id)) {
        throw new Error("command '" + id + "' not found");
      }
      module.exports.__executed.push(id);
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
    createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
    registerTreeDataProvider: noop,
    registerWebviewViewProvider: () => ({ dispose: noop }),
    setStatusBarMessage: noop,
    showTextDocument: async () => ({}),
    createWebviewPanel: (t, title, col) => {
      const p = { title, viewColumn: (col && col.viewColumn) || col, disposed: false, revealed: 0, _msgs: [],
        webview: { cspSource: 'vscode-resource:', options: {}, html: '',
                   onDidReceiveMessage: (f) => { p._onMsg = f; },
                   postMessage: (m) => p._msgs.push(m) },
        onDidDispose: (f) => { p._onDispose = f; },
        reveal: () => { p.revealed++; },
        dispose: () => { p.disposed = true; p._onDispose?.(); } };
      module.exports.__panels.push(p);
      return p;
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    withProgress: async (o, fn) => fn({ report: noop }),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ rowLimit:100, workFolder:'/Custom/OracleERPBIPublisherRunner',
      dataSource:'ApplicationDB_FSCM', wrapMode:'json', requestTimeout:180 }[k]), update: noop }),
    openTextDocument: async () => ({}),
    onDidChangeConfiguration: () => ({ dispose: noop }),
    fs: { writeFile: noop },
  },
  __registered: registered,
  __executed: [],
  __failCommands: [],
  __available: ['OracleERPBIPublisherRunner.results.focus','workbench.view.extension.OracleERPBIPublisherRunnerPanel'],
  __panels: [],
};
