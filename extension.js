'use strict';

/**
 * Oracle Fusion SQL Runner
 *
 * Ejecuta SQL contra Oracle Fusion usando exclusivamente los web services
 * estandar de BI Publisher (CatalogService v2 y ReportService v2). No requiere
 * ningun demonio local ni componente de terceros.
 *
 * Flujo de una ejecucion:
 *   1. Se toma el SQL del editor (seleccion o sentencia bajo el cursor)
 *   2. Se limita, se envuelve y se genera un _datamodel.xdm
 *   3. updateObject reemplaza el data model de trabajo en el catalogo
 *   4. runReport ejecuta el reporte asociado y devuelve el XML
 *   5. Se extraen las filas y se pintan en la rejilla
 */

const vscode = require('vscode');
const { BipClient, SoapFault, extractResult } = require('./src/bipClient');
const { buildDataModel, findBindParameters, ROWS_PARAM } = require('./src/dataModel');
const { ConnectionStore } = require('./src/connections');
const { ConnectionsProvider, HistoryProvider } = require('./src/providers');
const { ResultView, ROW_PRESETS } = require('./src/resultView');

const WORK_MODEL = 'FSR_WORK';   // data model de trabajo, se reescribe en cada consulta
let output;
let store;
let history;
let statusBar;
let rowsStatusBar;
let resultView;
let lastSql = null;              // para el boton "Reejecutar" del panel
let lastBinds = {};              // valores de los :BINDS de la ultima ejecucion
const PARAM_VALUES_KEY = 'OracleERPBIPublisherRunner.paramValues';
let extContext;

function log(msg) {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function cfg(key) {
    return vscode.workspace.getConfiguration('OracleERPBIPublisherRunner').get(key);
}

function activate(context) {
    extContext = context;
    output = vscode.window.createOutputChannel('Fusion SQL Runner');
    store = new ConnectionStore(context);
    history = new HistoryProvider(context);

    const connectionsProvider = new ConnectionsProvider(store);
    vscode.window.registerTreeDataProvider('OracleERPBIPublisherRunner.connections', connectionsProvider);
    vscode.window.registerTreeDataProvider('OracleERPBIPublisherRunner.history', history);

    // vista de resultados acoplada al panel inferior
    resultView = new ResultView(context, {
        onRowLimitChange: async (value, rerun) => {
            await applyRowLimit(value);
            if (rerun && lastSql) await runQuery(lastSql, lastBinds);
        },
        onRerun: () => runQuery(lastSql, lastBinds),
        log,
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ResultView.viewType, resultView, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'OracleERPBIPublisherRunner.setActiveConnection';

    rowsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    rowsStatusBar.command = 'OracleERPBIPublisherRunner.setRowLimit';

    context.subscriptions.push(statusBar, rowsStatusBar, output);
    store.onDidChange(() => refreshStatusBar());
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('OracleERPBIPublisherRunner.rowLimit')) refreshStatusBar();
        })
    );
    refreshStatusBar();

    const reg = (name, fn) =>
        context.subscriptions.push(vscode.commands.registerCommand(`OracleERPBIPublisherRunner.${name}`, fn));

    reg('addConnection', () => editConnection(null));
    reg('editConnection', (item) => editConnection(item?.id || store.activeId()));
    reg('deleteConnection', (item) => deleteConnection(item?.id));
    reg('setActiveConnection', (item) => setActiveConnection(item?.id));
    reg('testConnection', (item) => testConnection(item?.id));
    reg('bootstrap', (item) => bootstrap(item?.id));
    reg('runQuery', () => runQuery());
    reg('publishAsDataModel', () => publishAsDataModel());
    reg('newWorksheet', () => newWorksheet());
    reg('setRowLimit', () => setRowLimit());
    reg('showResults', async () => {
        const ok = await resultView.reveal();
        if (!ok) {
            vscode.window.showWarningMessage(
                'No se pudo abrir el panel de resultados. Si acabas de instalar o actualizar ' +
                'la extensión, recarga la ventana (Developer: Reload Window).',
                'Recargar ventana'
            ).then((a) => {
                if (a) vscode.commands.executeCommand('workbench.action.reloadWindow');
            });
        }
    });
    reg('editParameters', () => editParameters());
    reg('moveResultsBelow', async () => {
        const ok = await resultView.moveBelow();
        if (!ok) {
            vscode.window.showInformationMessage(
                'No hay una pestaña de resultados abierta que mover. Ejecuta una consulta primero.'
            );
        }
    });
    reg('describeService', () => describeService());
    reg('rerunFromHistory', (h) => runQuery(h?.sql));
    reg('clearHistory', () => history.clear());
    reg('showOutput', () => output.show());

    log('Extension activada.');
}

function refreshStatusBar() {
    const c = store.active();
    if (c) {
        statusBar.text = `$(database) ${c.name}`;
        statusBar.tooltip = `Fusion SQL: ${c.pod}\nClic para cambiar de conexión`;
        statusBar.show();

        const limit = cfg('rowLimit');
        rowsStatusBar.text = `$(list-ordered) ${limit === 0 ? '∞' : limit}`;
        rowsStatusBar.tooltip =
            `Límite de filas: ${limit === 0 ? 'sin límite' : limit}\nClic para cambiarlo`;
        rowsStatusBar.show();
    } else {
        statusBar.hide();
        rowsStatusBar.hide();
    }
}

// --------------------------------------------------------------- conexiones

async function editConnection(id) {
    const existing = id ? store.get(id) : null;

    const name = await vscode.window.showInputBox({
        title: existing ? 'Editar conexión' : 'Nueva conexión (1/4)',
        prompt: 'Nombre para identificar esta conexión',
        value: existing?.name || '',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'El nombre no puede estar vacío'),
    });
    if (!name) return;

    const pod = await vscode.window.showInputBox({
        title: existing ? 'Editar conexión' : 'Nueva conexión (2/4)',
        prompt: 'URL del pod de Oracle Fusion',
        placeHolder: 'https://mipod.fa.us2.oraclecloud.com',
        value: existing?.pod || '',
        ignoreFocusOut: true,
        validateInput: (v) => {
            try {
                const u = new URL(v);
                return u.protocol === 'https:' ? null : 'Debe usar https://';
            } catch { return 'URL no válida'; }
        },
    });
    if (!pod) return;

    const user = await vscode.window.showInputBox({
        title: existing ? 'Editar conexión' : 'Nueva conexión (3/4)',
        prompt: 'Usuario de Fusion (necesita rol BI Author o BI Administrator)',
        value: existing?.user || '',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'El usuario no puede estar vacío'),
    });
    if (!user) return;

    const password = await vscode.window.showInputBox({
        title: existing ? 'Editar conexión' : 'Nueva conexión (4/4)',
        prompt: existing
            ? 'Contraseña (déjalo vacío para conservar la actual)'
            : 'Contraseña — se guarda en el llavero del sistema, nunca en settings.json',
        password: true,
        ignoreFocusOut: true,
    });
    if (password === undefined) return;
    if (!existing && !password) {
        vscode.window.showErrorMessage('La contraseña es obligatoria para una conexión nueva.');
        return;
    }

    const conn = {
        id: existing?.id || `c${Date.now()}`,
        name: name.trim(),
        pod: pod.replace(/\/+$/, ''),
        user: user.trim(),
        folder: existing?.folder || cfg('workFolder'),
        dataSource: existing?.dataSource || cfg('dataSource'),
    };
    await store.save(conn, password);
    vscode.window.showInformationMessage(`Conexión "${conn.name}" guardada.`);
}

async function deleteConnection(id) {
    const conn = id ? store.get(id) : store.active();
    if (!conn) return;
    const yes = await vscode.window.showWarningMessage(
        `¿Eliminar la conexión "${conn.name}"?`,
        { modal: true },
        'Eliminar'
    );
    if (yes === 'Eliminar') {
        await store.remove(conn.id);
        vscode.window.showInformationMessage(`Conexión "${conn.name}" eliminada.`);
    }
}

async function setActiveConnection(id) {
    if (id) { await store.setActive(id); return; }
    const list = store.all();
    if (!list.length) return editConnection(null);
    const pick = await vscode.window.showQuickPick(
        list.map((c) => ({ label: c.name, description: c.pod, id: c.id })),
        { title: 'Conexión activa' }
    );
    if (pick) await store.setActive(pick.id);
}

/** Construye un cliente listo para usar a partir de una conexion guardada. */
async function clientFor(id) {
    const conn = id ? store.get(id) : store.active();
    if (!conn) {
        const add = await vscode.window.showWarningMessage(
            'No hay ninguna conexión configurada.', 'Añadir conexión'
        );
        if (add) await editConnection(null);
        return null;
    }
    const password = await store.password(conn.id);
    if (!password) {
        vscode.window.showErrorMessage(
            `No se encontró la contraseña de "${conn.name}". Edita la conexión para volver a introducirla.`
        );
        return null;
    }
    return {
        conn,
        client: new BipClient({
            pod: conn.pod,
            user: conn.user,
            password,
            timeout: cfg('requestTimeout'),
            log,
        }),
    };
}

async function testConnection(id) {
    const ctx = await clientFor(id);
    if (!ctx) return;
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Probando ${ctx.conn.name}…` },
        async () => {
            try {
                const ok = await ctx.client.objectExists(`${ctx.conn.folder}/${WORK_MODEL}.xdm`);
                const ops = await ctx.client.describeService('CatalogService');
                log(`CatalogService responde con ${Object.keys(ops).length} operaciones.`);
                vscode.window.showInformationMessage(
                    `Conexión correcta con ${ctx.conn.name}. ` +
                    (ok ? 'Los objetos de trabajo ya existen.'
                        : 'Falta crear los objetos de trabajo (usa "Crear objetos de trabajo en el catálogo").')
                );
            } catch (err) {
                reportError(err, 'No se pudo conectar');
            }
        }
    );
}

// ------------------------------------------------------------------ trabajo

/**
 * Crea la carpeta y el data model de trabajo en el catalogo.
 *
 * El reporte (.xdo) hay que crearlo a mano una sola vez en la UI de BI
 * Publisher: uploadObject no puede generar un reporte valido sin conocer la
 * plantilla que espera cada release, y como el .xdo solo referencia al data
 * model, no vuelve a tocarse nunca.
 */
async function bootstrap(id) {
    const ctx = await clientFor(id);
    if (!ctx) return;
    const { conn, client } = ctx;
    const modelPath = `${conn.folder}/${WORK_MODEL}.xdm`;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Preparando el catálogo…' },
        async (progress) => {
            try {
                const parts = conn.folder.replace(/^\/+|\/+$/g, '').split('/');
                let parent = '';
                for (const part of parts) {
                    const full = `${parent}/${part}`;
                    progress.report({ message: `Carpeta ${full}` });
                    try { await client.createFolder(parent || '/', part); }
                    catch (e) { log(`createFolder ${full}: ${e.message}`); }
                    parent = full;
                }

                progress.report({ message: 'Data model de trabajo' });
                const built = buildDataModel({
                    name: WORK_MODEL,
                    folder: conn.folder,
                    sql: 'SELECT 1 FROM DUAL',
                    dataSource: conn.dataSource,
                    wrapMode: 'none',
                    maxRows: 0,
                    columns: [{ name: '1', dataType: 'xsd:double' }],
                    description: 'Data model de trabajo de Fusion SQL Runner',
                });
                await client.uploadObject(conn.folder, WORK_MODEL, built.zip, 'xdmz');

                const msg = await vscode.window.showInformationMessage(
                    `Data model creado en ${modelPath}. Falta un paso manual: crea en la UI de ` +
                    `BI Publisher un reporte llamado ${WORK_MODEL} en ${conn.folder} que apunte a ` +
                    'este data model. Solo hay que hacerlo una vez.',
                    'Abrir BI Publisher'
                );
                if (msg === 'Abrir BI Publisher') {
                    vscode.env.openExternal(vscode.Uri.parse(`${conn.pod}/xmlpserver`));
                }
            } catch (err) {
                reportError(err, 'Falló la preparación del catálogo');
            }
        }
    );
}

// ------------------------------------------------------------- parametros

function storedParamValues() {
    return extContext.globalState.get(PARAM_VALUES_KEY, {});
}

async function rememberParamValues(values) {
    await extContext.globalState.update(PARAM_VALUES_KEY, {
        ...storedParamValues(),
        ...values,
    });
}

/**
 * Pide los valores de los :BINDS de la consulta.
 *
 * Devuelve un objeto { NOMBRE: valor }, o null si el usuario cancela — en cuyo
 * caso la consulta no debe ejecutarse: mejor eso que lanzarla con un bind vacio
 * y devolver cero filas sin explicacion.
 *
 * Los valores se recuerdan entre ejecuciones y se ofrecen como valor inicial,
 * que es lo que hace cualquier cliente SQL decente.
 */
async function promptForBinds(names, { force = false } = {}) {
    if (!names.length) return {};

    const stored = storedParamValues();
    const mode = cfg('promptParameters');
    const values = {};

    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const previous = stored[name];

        if (!force && mode === 'onlyNew' && previous !== undefined) {
            values[name] = previous;
            continue;
        }

        const entered = await vscode.window.showInputBox({
            title: names.length > 1
                ? `Parámetro ${i + 1} de ${names.length}`
                : 'Parámetro de la consulta',
            prompt: `Valor para :${name}`,
            value: previous ?? '',
            ignoreFocusOut: true,
            placeHolder: 'Deja vacío para pasar NULL',
        });
        if (entered === undefined) return null;   // cancelado
        values[name] = entered;
    }

    await rememberParamValues(values);
    return values;
}

/** Reeditar los parametros de la última consulta y relanzarla. */
async function editParameters() {
    if (!lastSql) {
        vscode.window.showInformationMessage('Ejecuta una consulta primero.');
        return;
    }
    const names = findBindParameters(lastSql);
    if (!names.length) {
        vscode.window.showInformationMessage('La última consulta no tiene parámetros de entrada.');
        return;
    }
    const values = await promptForBinds(names, { force: true });
    if (values === null) return;
    await runQuery(lastSql, values);
}

/** SQL a ejecutar: la selección, o la sentencia donde está el cursor. */
function currentSql(editor) {
    if (!editor) return null;
    const sel = editor.selection;
    if (!sel.isEmpty) return editor.document.getText(sel);

    const text = editor.document.getText();
    const offset = editor.document.offsetAt(sel.active);
    // partir por ';' respetando cadenas entrecomilladas
    const stmts = [];
    let start = 0, inStr = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'") {
            if (inStr && text[i + 1] === "'") { i++; continue; }
            inStr = !inStr;
        } else if (ch === ';' && !inStr) {
            stmts.push({ start, end: i });
            start = i + 1;
        }
    }
    stmts.push({ start, end: text.length });
    const hit = stmts.find((s) => offset >= s.start && offset <= s.end) || stmts[stmts.length - 1];
    return text.slice(hit.start, hit.end);
}

async function runQuery(sqlOverride, bindOverride) {
    const editor = vscode.window.activeTextEditor;
    const sql = (sqlOverride || currentSql(editor) || '').trim();
    if (!sql) {
        vscode.window.showWarningMessage('No hay SQL que ejecutar. Selecciona una consulta o sitúa el cursor en ella.');
        return;
    }

    // parametros de entrada :BIND antes de tocar el pod
    const bindNames = findBindParameters(sql);
    let binds = bindOverride;
    if (!binds) {
        binds = await promptForBinds(bindNames);
        if (binds === null) {
            log('Ejecución cancelada: faltan valores de parámetros.');
            return;
        }
    }
    lastBinds = binds;

    const ctx = await clientFor();
    if (!ctx) return;
    const { conn, client } = ctx;
    const modelPath = `${conn.folder}/${WORK_MODEL}.xdm`;
    const reportPath = `${conn.folder}/${WORK_MODEL}.xdo`;
    const wrapMode = cfg('wrapMode');
    const maxRows = cfg('rowLimit');
    const started = Date.now();

    lastSql = sql;
    // mostrar el panel es opcional: nunca debe impedir que la consulta corra
    try { await resultView.reveal(); } catch (e) { log(`reveal falló: ${e.message}`); }
    resultView.setBusy('Actualizando el data model…');

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Fusion SQL: ejecutando…' },
        async () => {
            try {
                const built = buildDataModel({
                    name: WORK_MODEL,
                    folder: conn.folder,
                    sql,
                    dataSource: conn.dataSource,
                    wrapMode,
                    maxRows,
                    useRowsParam: false,
                    contentOnly: true,
                    bindParameters: bindNames.map((n) => ({ name: n, value: binds[n] })),
                });
                log(`SQL efectivo:\n${built.effectiveSql}`);
                if (bindNames.length) {
                    log('Parámetros: ' +
                        bindNames.map((n) => `:${n} = ${binds[n] === '' ? 'NULL' : binds[n]}`).join(', '));
                }
                await client.updateObject(modelPath, built.content);

                resultView.setBusy('Ejecutando la consulta…');
                const raw = await client.runReport(reportPath, {
                    format: 'xml',
                    params: bindNames.length ? binds : null,
                });
                const { rows } = extractResult(raw, wrapMode);
                const ms = Date.now() - started;

                await history.add({ sql, ok: true, rows: rows.length, ms, at: Date.now() });
                resultView.setData({
                    rows,
                    sql,
                    ms,
                    connectionName: conn.name,
                    truncated: maxRows > 0 && rows.length >= maxRows,
                    params: bindNames.map((n) => ({ name: n, value: binds[n] })),
                });
                log(`${rows.length} filas en ${ms} ms.`);

                // si el panel nunca llego a abrirse, el usuario no veria nada
                if (!resultView.isVisible) {
                    vscode.window.showInformationMessage(
                        `${rows.length} filas en ${ms} ms. El panel de resultados no está abierto.`,
                        'Abrir panel'
                    ).then((a) => { if (a) resultView.reveal(); });
                }
            } catch (err) {
                await history.add({ sql, ok: false, rows: 0, ms: Date.now() - started, at: Date.now() });
                resultView.setError(err.message);
                reportError(err, 'Falló la ejecución', { modelPath, reportPath });
            }
        }
    );
}

/** Publica el SQL actual como un data model permanente, con nombre propio. */
async function publishAsDataModel() {
    const editor = vscode.window.activeTextEditor;
    const sql = (currentSql(editor) || '').trim();
    if (!sql) {
        vscode.window.showWarningMessage('No hay SQL que publicar.');
        return;
    }

    const ctx = await clientFor();
    if (!ctx) return;
    const { conn, client } = ctx;

    const suggested = editor?.document.isUntitled
        ? 'MI_DATA_MODEL'
        : (editor?.document.fileName.split(/[\\/]/).pop() || '').replace(/\.sql$/i, '').toUpperCase();

    const name = await vscode.window.showInputBox({
        title: 'Publicar como Data Model',
        prompt: 'Nombre del data model en el catálogo',
        value: suggested || 'MI_DATA_MODEL',
        ignoreFocusOut: true,
        validateInput: (v) =>
            /^[A-Za-z0-9_ -]+$/.test(v.trim()) ? null : 'Solo letras, números, espacios, guion y guion bajo',
    });
    if (!name) return;

    const folder = await vscode.window.showInputBox({
        title: 'Publicar como Data Model',
        prompt: 'Carpeta del catálogo (debe estar bajo /Custom)',
        value: conn.folder,
        ignoreFocusOut: true,
        validateInput: (v) =>
            v.startsWith('/Custom') ? null : 'Los objetos personalizados deben vivir bajo /Custom',
    });
    if (!folder) return;

    // si la consulta trae :BINDS, se declaran como parametros del modelo
    const publishBindNames = findBindParameters(sql);
    let publishBinds = [];
    if (publishBindNames.length) {
        const values = await promptForBinds(publishBindNames, { force: true });
        if (values === null) return;
        publishBinds = publishBindNames.map((n) => ({ name: n, value: values[n] }));
    }

    const withParam = await vscode.window.showQuickPick(
        [
            { label: 'Límite fijo', description: `${cfg('rowLimit')} filas escritas en el modelo`, param: false },
            { label: `Parámetro ${ROWS_PARAM}`, description: 'el límite se pasa en cada ejecución', param: true },
            { label: 'Sin límite', description: 'devuelve todas las filas', param: false, none: true },
        ],
        { title: 'Límite de filas del data model' }
    );
    if (!withParam) return;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Publicando ${name}…` },
        async () => {
            try {
                const built = buildDataModel({
                    name: name.trim(),
                    folder,
                    sql,
                    dataSource: conn.dataSource,
                    wrapMode: cfg('wrapMode'),
                    maxRows: withParam.none ? 0 : cfg('rowLimit'),
                    useRowsParam: withParam.param,
                    description: 'Publicado desde VS Code',
                    // los :BINDS se declaran como parametros del data model,
                    // con el ultimo valor usado como valor por defecto
                    bindParameters: publishBinds,
                });

                const exists = await client.objectExists(built.catalogPath);
                if (exists) {
                    const replace = await vscode.window.showWarningMessage(
                        `${built.catalogPath} ya existe. ¿Reemplazar su contenido?`,
                        { modal: true },
                        'Reemplazar'
                    );
                    if (replace !== 'Reemplazar') return;
                    // updateObject conserva permisos, GUID y suscripciones
                    await client.updateObject(built.catalogPath, built.content);
                } else {
                    await client.uploadObject(folder, name.trim(), built.zip, 'xdmz');
                }

                const action = await vscode.window.showInformationMessage(
                    `Data model ${exists ? 'actualizado' : 'publicado'} en ${built.catalogPath}`,
                    'Abrir en BI Publisher'
                );
                if (action) vscode.env.openExternal(vscode.Uri.parse(`${conn.pod}/xmlpserver`));
            } catch (err) {
                reportError(err, 'Falló la publicación');
            }
        }
    );
}

async function newWorksheet() {
    const doc = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: '-- Fusion SQL Runner\n-- Ctrl+Enter ejecuta la sentencia bajo el cursor\n\nSELECT 1 FROM DUAL;\n',
    });
    await vscode.window.showTextDocument(doc);
}

/** Guarda el limite y refresca los indicadores que lo muestran. */
async function applyRowLimit(value) {
    await vscode.workspace.getConfiguration('OracleERPBIPublisherRunner')
        .update('rowLimit', value, vscode.ConfigurationTarget.Global);
    refreshStatusBar();
    log(`Límite de filas: ${value === 0 ? 'sin límite' : value}`);
}

/** Selector de limite con los mismos valores que ofrece el panel. */
async function setRowLimit() {
    const current = cfg('rowLimit');
    const items = [
        ...ROW_PRESETS.map((v) => ({
            label: `${v} filas`,
            description: v === current ? 'actual' : undefined,
            value: v,
        })),
        {
            label: 'Sin límite',
            description: current === 0 ? 'actual' : 'cuidado con las tablas grandes',
            value: 0,
        },
        { label: '$(edit) Otro…', value: 'custom' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'Máximo de filas por consulta',
        placeHolder: `Actualmente: ${current === 0 ? 'sin límite' : current + ' filas'}`,
    });
    if (!pick) return;

    let value = pick.value;
    if (value === 'custom') {
        const typed = await vscode.window.showInputBox({
            title: 'Límite de filas',
            prompt: 'Número máximo de filas (0 = sin límite)',
            value: String(current),
            validateInput: (v) => (/^\d+$/.test(v) ? null : 'Introduce un número entero positivo'),
        });
        if (typed === undefined) return;
        value = parseInt(typed, 10);
    }

    await applyRowLimit(value);
    if (lastSql) {
        const again = await vscode.window.showInformationMessage(
            `Límite ajustado a ${value === 0 ? 'sin límite' : value + ' filas'}.`,
            'Reejecutar consulta'
        );
        if (again) await runQuery(lastSql);
    }
}

/** Vuelca en el canal de salida las firmas reales del pod, leidas del WSDL. */
async function describeService() {
    const ctx = await clientFor();
    if (!ctx) return;
    try {
        output.show(true);
        for (const service of ['CatalogService', 'ReportService']) {
            const ops = await ctx.client.describeService(service);
            output.appendLine(`\n===== ${service} (${ctx.conn.pod}) =====`);
            for (const [op, params] of Object.entries(ops).sort()) {
                output.appendLine(`\n${op}(`);
                for (const p of params) {
                    output.appendLine(`    ${p.name.padEnd(34)} : ${p.type}`);
                }
                output.appendLine(')');
            }
        }
    } catch (err) {
        reportError(err, 'No se pudo leer el WSDL');
    }
}

// ------------------------------------------------------------------ errores

function reportError(err, title, ctx = {}) {
    log(`${title}: ${err.message}`);
    if (err.body) log(err.body.slice(0, 2000));

    let hint = '';
    const m = err.message || '';
    if (/does not exist|not found|no existe/i.test(m) && ctx.reportPath) {
        hint = `\n\nUn .xdm no se ejecuta solo: necesita un reporte que lo referencie. ` +
            `Crea una vez ${ctx.reportPath} en la UI de BI Publisher apuntando a ${ctx.modelPath}.`;
    } else if (/JSON_OBJECT|ORA-00907|ORA-00904/i.test(m)) {
        hint = '\n\nSi tu base no soporta JSON_OBJECT(*) (necesita Oracle 19c+), ' +
            'cambia OracleERPBIPublisherRunner.wrapMode a "xml".';
    } else if (/ORA-00942/i.test(m)) {
        hint = '\n\nTabla o vista inexistente para este data source. ' +
            'Prueba a cambiar el data source de la conexión (FSCM / HCM / CRM).';
    } else if (/Unmarshalling/i.test(m)) {
        hint = '\n\nLa firma SOAP de tu pod difiere. Ejecuta "Inspeccionar firmas del CatalogService".';
    }

    vscode.window.showErrorMessage(`${title}: ${m.split('\n')[0]}${hint}`, 'Ver registro')
        .then((a) => { if (a) output.show(); });
}

function deactivate() {}

module.exports = { activate, deactivate };
