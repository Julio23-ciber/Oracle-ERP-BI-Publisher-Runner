'use strict';

/**
 * Vista de resultados, con dos modos de presentacion.
 *
 *   panel   WebviewView acoplado al panel inferior, junto a Terminal y
 *           Problemas. Es el modo preferido: se maximiza con el gesto habitual
 *           del panel y se puede arrastrar a otra zona.
 *   editor  WebviewPanel como pestana del editor. Es el respaldo, y NO depende
 *           de que VS Code haya aceptado la contribucion viewsContainers del
 *           manifiesto, asi que funciona siempre.
 *
 * Al activarse se comprueba con getCommands() si el contenedor del panel llego
 * a registrarse. Si no, se usa el modo editor desde el primer momento: sin
 * llamadas fallidas, sin retardo y sin que el usuario se quede sin ver nada.
 *
 * La vista del panel se crea de forma perezosa (VS Code no llama a
 * resolveWebviewView hasta mostrarla), asi que el ultimo conjunto de datos se
 * guarda en cola y se reenvia en cuanto exista un webview al que mandarlo.
 */

const vscode = require('vscode');

const ROW_PRESETS = [10, 50, 100, 500, 1000, 5000];

function nonce() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

class ResultView {
    static viewType = 'OracleERPBIPublisherRunner.results';

    constructor(context, callbacks = {}) {
        this.context = context;
        this.callbacks = callbacks;   // { onRowLimitChange, onRerun }
        this.log = callbacks.log;
        this.view = null;             // WebviewView del panel inferior
        this.panel = null;            // WebviewPanel de respaldo, en el editor
        this.pending = null;          // datos llegados antes de que exista webview
        this.rows = [];
        this.panelContainerAvailable = null;   // null = aun sin comprobar
    }

    /** El webview activo, sea del panel inferior o de la pestana del editor. */
    get webview() {
        return this.view?.webview || this.panel?.webview || null;
    }

    get isVisible() {
        return !!this.webview;
    }

    /**
     * ¿Registro VS Code el contenedor del panel?
     *
     * Si la contribucion viewsContainers fue rechazada, los comandos que la
     * acompanan no existen. Comprobarlo una sola vez evita intentos condenados
     * al fallo en cada consulta.
     */
    async checkPanelContainer() {
        const forced = vscode.workspace.getConfiguration('OracleERPBIPublisherRunner').get('resultsLocation');
        if (forced === 'editor') return false;
        if (this.panelContainerAvailable !== null) return this.panelContainerAvailable;
        try {
            const all = await vscode.commands.getCommands(true);
            this.panelContainerAvailable =
                all.includes(`${ResultView.viewType}.focus`) ||
                all.includes('workbench.view.extension.OracleERPBIPublisherRunnerPanel');
        } catch {
            this.panelContainerAvailable = false;
        }
        this.log?.(this.panelContainerAvailable
            ? 'Panel inferior disponible.'
            : 'El contenedor del panel no está registrado; los resultados irán al editor.');
        return this.panelContainerAvailable;
    }

    /** Conecta el manejador de mensajes a cualquiera de los dos webviews. */
    _wire(webview) {
        webview.options = { enableScripts: true };
        webview.html = this.html(webview);
        webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'ready':
                    this.post({ command: 'setRowLimit', value: this.rowLimit() });
                    if (this.pending) { this.post(this.pending); this.pending = null; }
                    break;
                case 'export':
                    await this.export(msg.format);
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(msg.text);
                    vscode.window.setStatusBarMessage('Copiado al portapapeles', 2000);
                    break;
                case 'rowLimit':
                    await this.callbacks.onRowLimitChange?.(msg.value, msg.rerun);
                    break;
                case 'rerun':
                    await this.callbacks.onRerun?.();
                    break;
            }
        });
    }

    /**
     * Abre (o reutiliza) la pestana del editor de respaldo.
     *
     * Por defecto la coloca DEBAJO del editor SQL, que es la disposicion
     * habitual de una herramienta de consultas. VS Code no permite pedir un
     * grupo inferior al crear el webview, asi que se crea al lado y se mueve
     * con moveEditorToBelowGroup; despues se devuelve el foco al SQL.
     */
    async ensureEditorPanel() {
        if (this.panel) return this.panel;

        const below = vscode.workspace.getConfiguration('OracleERPBIPublisherRunner')
            .get('editorFallbackPosition') !== 'beside';
        const prevEditor = vscode.window.activeTextEditor;

        this.panel = vscode.window.createWebviewPanel(
            'fusionSqlResults',
            'Resultados · Fusion SQL',
            // para poder moverlo hay que crearlo con el foco puesto en el
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !below },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.onDidDispose(() => { this.panel = null; });
        this._wire(this.panel.webview);

        if (below) {
            try {
                await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
                // devolver el cursor al SQL: el usuario sigue escribiendo ahi
                if (prevEditor) {
                    await vscode.window.showTextDocument(prevEditor.document, {
                        viewColumn: prevEditor.viewColumn,
                        preserveFocus: false,
                    });
                }
                this.log?.('Resultados abiertos debajo del editor.');
            } catch (err) {
                this.log?.(`No se pudo mover el panel abajo: ${err.message}`);
            }
        } else {
            this.log?.('Resultados abiertos junto al editor.');
        }
        return this.panel;
    }

    /** Mueve la pestana de resultados al grupo inferior, a peticion del usuario. */
    async moveBelow() {
        if (!this.panel) return false;
        const prevEditor = vscode.window.activeTextEditor;
        try {
            this.panel.reveal(this.panel.viewColumn, false);   // hay que enfocarla
            await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
            if (prevEditor) {
                await vscode.window.showTextDocument(prevEditor.document, {
                    viewColumn: prevEditor.viewColumn,
                    preserveFocus: false,
                });
            }
            return true;
        } catch (err) {
            this.log?.(`No se pudo mover el panel abajo: ${err.message}`);
            return false;
        }
    }

    resolveWebviewView(webviewView) {
        this.view = webviewView;
        this.panelContainerAvailable = true;
        this._wire(webviewView.webview);

        // el respaldo del editor ya no hace falta
        if (this.panel) { this.panel.dispose(); this.panel = null; }
        webviewView.onDidDispose?.(() => { this.view = null; });

        // mantener el selector sincronizado si el ajuste cambia por otra via
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('OracleERPBIPublisherRunner.rowLimit')) {
                    this.post({ command: 'setRowLimit', value: this.rowLimit() });
                }
            })
        );
    }

    rowLimit() {
        return vscode.workspace.getConfiguration('OracleERPBIPublisherRunner').get('rowLimit');
    }

    post(message) {
        this.webview?.postMessage(message);
    }

    /**
     * Trae el panel inferior al frente sin robar el foco del editor.
     *
     * NUNCA lanza. Mostrar el panel es una comodidad: si falla, la consulta
     * tiene que seguir su curso igualmente.
     *
     * El comando `<viewId>.focus` lo genera el propio VS Code al registrar las
     * vistas del manifiesto, pero no esta disponible si la ventana aun no ha
     * recargado tras instalar o actualizar la extension. Por eso se intentan
     * varias vias en orden y se aceptan los fallos.
     */
    async reveal() {
        if (this.view) {
            try { this.view.show?.(true); return true; } catch { /* la vista murio */ }
        }

        if (await this.checkPanelContainer()) {
            const attempts = [
                `${ResultView.viewType}.focus`,
                'workbench.view.extension.OracleERPBIPublisherRunnerPanel',
            ];
            for (const cmd of attempts) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    return true;
                } catch (err) {
                    this.log?.(`reveal: "${cmd}" no disponible (${err.message})`);
                }
            }
            // el contenedor decia estar y no responde: no volver a intentarlo
            this.panelContainerAvailable = false;
        }

        // respaldo garantizado: pestana del editor, sin depender del manifiesto
        try {
            const panel = await this.ensureEditorPanel();
            panel.reveal(panel.viewColumn, true);
            return true;
        } catch (err) {
            this.log?.(`No se pudo abrir la pestaña de resultados: ${err.message}`);
            return false;
        }
    }

    setBusy(message) {
        const payload = { command: 'busy', message };
        if (this.webview) this.post(payload); else this.pending = payload;
    }

    setError(message) {
        const payload = { command: 'error', message };
        this.rows = [];
        if (this.webview) this.post(payload); else this.pending = payload;
    }

    setData({ rows, sql, ms, connectionName, truncated, params }) {
        this.rows = rows || [];
        this.sql = sql;
        const payload = {
            command: 'setData',
            rows: this.rows,
            meta: {
                ms,
                connectionName,
                count: this.rows.length,
                truncated: !!truncated,
                limit: this.rowLimit(),
                params: params || [],
            },
        };
        if (this.panel) this.panel.title = `Resultados (${this.rows.length}) · Fusion SQL`;
        if (this.webview) this.post(payload); else this.pending = payload;
    }

    async export(format) {
        if (!this.rows.length) {
            vscode.window.showWarningMessage('No hay filas que exportar.');
            return;
        }
        const uri = await vscode.window.showSaveDialog({
            filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
            saveLabel: 'Exportar',
        });
        if (!uri) return;

        let text;
        if (format === 'csv') {
            const fields = [];
            for (const r of this.rows) {
                for (const k of Object.keys(r)) if (!fields.includes(k)) fields.push(k);
            }
            const cell = (v) => {
                if (v === null || v === undefined) return '';
                const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
                return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            // BOM para que Excel reconozca UTF-8
            text = '﻿' + [
                fields.join(','),
                ...this.rows.map((r) => fields.map((f) => cell(r[f])).join(',')),
            ].join('\r\n');
        } else {
            text = JSON.stringify(this.rows, null, 2);
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        const open = await vscode.window.showInformationMessage(
            `Exportadas ${this.rows.length} filas.`, 'Abrir'
        );
        if (open === 'Abrir') vscode.commands.executeCommand('vscode.open', uri);
    }

    html(webview) {
        const n = nonce();
        const options = ROW_PRESETS
            .map((v) => `<option value="${v}">${v} filas</option>`)
            .join('');

        return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; height: 100vh; overflow: hidden;
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-panel-background, var(--vscode-editor-background));
  }
  .toolbar {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 4px 8px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .meta {
    font-size: .85em; color: var(--vscode-descriptionForeground);
    margin-right: auto; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .meta .warn { color: var(--vscode-editorWarning-foreground); font-weight: 600; }
  .meta .params {
    color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family);
  }
  label.rows { display: flex; align-items: center; gap: 4px; font-size: .85em; white-space: nowrap; }
  select, input[type=search], input[type=number] {
    padding: 2px 6px; border-radius: 2px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border, transparent));
  }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  input[type=search] { min-width: 140px; }
  input#custom { width: 74px; display: none; }
  button {
    padding: 2px 9px; cursor: pointer; border: none; border-radius: 2px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    font-size: .9em;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  button.primary {
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .wrap { flex: 1 1 auto; overflow: auto; min-height: 0; }
  table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; }
  th, td {
    padding: 2px 10px; text-align: left; white-space: nowrap;
    border-bottom: 1px solid var(--vscode-panel-border);
    max-width: 400px; overflow: hidden; text-overflow: ellipsis;
  }
  th {
    position: sticky; top: 0; z-index: 2; cursor: pointer; user-select: none;
    background: var(--vscode-keybindingTable-headerBackground, var(--vscode-editorWidget-background));
    border-bottom: 2px solid var(--vscode-panel-border);
    font-weight: 600;
  }
  th:hover { background: var(--vscode-list-hoverBackground); }
  th .arrow { opacity: .6; margin-left: 4px; font-size: .75em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.null { opacity: .38; font-style: italic; }
  tbody tr:nth-child(even) td { background: var(--vscode-tree-tableOddRowsBackground, transparent); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.rownum, th.rownum {
    position: sticky; left: 0; z-index: 1;
    opacity: .5; text-align: right; font-variant-numeric: tabular-nums;
    background: var(--vscode-panel-background, var(--vscode-editor-background));
    border-right: 1px solid var(--vscode-panel-border);
  }
  th.rownum { z-index: 3; background: var(--vscode-keybindingTable-headerBackground, var(--vscode-editorWidget-background)); }
  .center {
    padding: 28px 16px; text-align: center;
    color: var(--vscode-descriptionForeground); font-size: .92em;
  }
  .center.err {
    text-align: left; white-space: pre-wrap; font-family: var(--vscode-editor-font-family);
    color: var(--vscode-errorForeground); padding: 14px 16px;
  }
  .spin { display: inline-block; animation: sp 1s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="toolbar">
  <span class="meta" id="meta">Sin resultados</span>
  <label class="rows">
    Filas
    <select id="rows" title="Máximo de filas por consulta">
      ${options}
      <option value="0">Sin límite</option>
      <option value="custom">Otro…</option>
    </select>
  </label>
  <input type="number" id="custom" min="0" step="10" placeholder="nº" title="Pulsa Enter para aplicar">
  <input type="search" id="filter" placeholder="Filtrar…" aria-label="Filtrar filas">
  <button id="rerun" class="primary" title="Volver a ejecutar la última consulta">Reejecutar</button>
  <button id="csv">CSV</button>
  <button id="json">JSON</button>
</div>
<div class="wrap" id="wrap"><div class="center">Ejecuta una consulta con Ctrl+Enter.</div></div>

<script nonce="${n}">
const vscode = acquireVsCodeApi();
let rows = [], fields = [], sortField = null, sortDir = 1, filter = '';

function computeFields(data) {
  const out = [];
  for (const r of data) for (const k of Object.keys(r)) if (!out.includes(k)) out.push(k);
  return out;
}

function visible() {
  let out = rows;
  if (filter) {
    const f = filter.toLowerCase();
    out = out.filter(r => fields.some(k => String(r[k] ?? '').toLowerCase().includes(f)));
  }
  if (sortField) {
    out = out.slice().sort((a, b) => {
      const x = a[sortField], y = b[sortField];
      if (x === y) return 0;
      if (x === null || x === undefined || x === '') return 1;
      if (y === null || y === undefined || y === '') return -1;
      const nx = Number(x), ny = Number(y);
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * sortDir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * sortDir;
    });
  }
  return out;
}

function render() {
  const wrap = document.getElementById('wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="center">La consulta no devolvió filas.</div>';
    return;
  }
  const data = visible();
  const head = '<tr><th class="rownum"></th>' + fields.map(f =>
    '<th data-f="' + esc(f) + '">' + esc(f) +
    (sortField === f ? '<span class="arrow">' + (sortDir === 1 ? '▲' : '▼') + '</span>' : '') +
    '</th>').join('') + '</tr>';

  const body = data.map((r, i) => '<tr><td class="rownum">' + (i + 1) + '</td>' +
    fields.map(f => {
      const v = r[f];
      if (v === null || v === undefined || v === '') return '<td class="null">null</td>';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const isNum = typeof v === 'number' || (s.trim() !== '' && !isNaN(Number(s)));
      return '<td class="' + (isNum ? 'num' : '') + '" title="' + esc(s) + '">' + esc(s) + '</td>';
    }).join('') + '</tr>').join('');

  wrap.innerHTML = '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';

  wrap.querySelectorAll('th[data-f]').forEach(th => {
    th.addEventListener('click', () => {
      const f = th.getAttribute('data-f');
      if (sortField === f) sortDir = -sortDir; else { sortField = f; sortDir = 1; }
      render();
    });
  });
  wrap.querySelectorAll('tbody td:not(.rownum)').forEach(td => {
    td.addEventListener('dblclick', () =>
      vscode.postMessage({ command: 'copy', text: td.getAttribute('title') || td.textContent }));
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('message', e => {
  const m = e.data;
  const wrap = document.getElementById('wrap');
  const meta = document.getElementById('meta');

  if (m.command === 'busy') {
    wrap.innerHTML = '<div class="center"><span class="spin">◐</span> ' + esc(m.message || 'Ejecutando…') + '</div>';
    meta.textContent = '…';
    return;
  }
  if (m.command === 'error') {
    wrap.innerHTML = '<div class="center err">' + esc(m.message) + '</div>';
    meta.textContent = 'Error';
    rows = []; fields = [];
    return;
  }
  if (m.command === 'setRowLimit') {
    const sel = document.getElementById('rows');
    const v = String(m.value);
    if ([...sel.options].some(o => o.value === v)) {
      sel.value = v;
      document.getElementById('custom').style.display = 'none';
    } else {
      sel.value = 'custom';
      const c = document.getElementById('custom');
      c.style.display = 'inline-block';
      c.value = m.value;
    }
    return;
  }
  if (m.command !== 'setData') return;

  rows = m.rows || [];
  fields = computeFields(rows);
  sortField = null; sortDir = 1;
  meta.innerHTML =
    '<strong>' + m.meta.count + '</strong> filas · ' + fields.length + ' col · ' +
    m.meta.ms + ' ms · ' + esc(m.meta.connectionName || '') +
    ((m.meta.params && m.meta.params.length)
      ? ' · <span class="params" title="Parámetros de entrada">' +
        m.meta.params.map(p => ':' + esc(p.name) + '=' +
          esc(p.value === '' ? 'NULL' : p.value)).join(' ') + '</span>'
      : '') +
    (m.meta.truncated ? ' · <span class="warn">límite de ' + m.meta.limit + ' alcanzado</span>' : '');
  render();
});

document.getElementById('filter').addEventListener('input', e => {
  filter = e.target.value; render();
});
document.getElementById('csv').addEventListener('click',
  () => vscode.postMessage({ command: 'export', format: 'csv' }));
document.getElementById('json').addEventListener('click',
  () => vscode.postMessage({ command: 'export', format: 'json' }));
document.getElementById('rerun').addEventListener('click',
  () => vscode.postMessage({ command: 'rerun' }));

document.getElementById('rows').addEventListener('change', e => {
  const custom = document.getElementById('custom');
  if (e.target.value === 'custom') {
    custom.style.display = 'inline-block';
    custom.focus();
    return;
  }
  custom.style.display = 'none';
  vscode.postMessage({ command: 'rowLimit', value: parseInt(e.target.value, 10), rerun: true });
});
document.getElementById('custom').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = parseInt(e.target.value, 10);
  if (!isNaN(v) && v >= 0) vscode.postMessage({ command: 'rowLimit', value: v, rerun: true });
});

vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }
}

module.exports = { ResultView, ROW_PRESETS };
