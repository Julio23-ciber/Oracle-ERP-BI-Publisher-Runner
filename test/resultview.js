const Module=require('module'), path=require('path'), assert=require('assert');
const orig=Module._resolveFilename;
Module._resolveFilename=function(r,...a){ return r==='vscode'?path.resolve(__dirname,'stub/vscode.js'):orig.call(this,r,...a); };
const { ResultView, ROW_PRESETS } = require('../src/resultView');
const noop2 = () => {};

let pass=0, fail=0;
const check=(n,f)=>{ try{ f(); console.log('  ok    '+n); pass++; }catch(e){ console.log('  FALLO '+n+'\n        '+e.message); fail++; } };

const ctx={ subscriptions:[] };
let limitCalls=[], rerunCalls=0;
const view=new ResultView(ctx,{ onRowLimitChange:(v,r)=>{limitCalls.push([v,r]);}, onRerun:()=>{rerunCalls++;} });

console.log('\nCola previa a la creacion de la vista');
view.setData({rows:[{A:1}],sql:'SELECT 1',ms:12,connectionName:'dev'});
check('los datos se encolan si aun no hay vista', ()=>assert.ok(view.pending && view.pending.command==='setData'));

// simular que VS Code resuelve la vista
const posted=[]; let onMsg=null;
view.resolveWebviewView({
  webview:{ options:{}, cspSource:'vscode-resource:', set html(v){this._h=v;}, get html(){return this._h;},
            postMessage:(m)=>posted.push(m), onDidReceiveMessage:(f)=>{onMsg=f;} },
});
check('el HTML se genera', ()=>assert.ok(view.view.webview.html.includes('<table') || view.view.webview.html.includes('acquireVsCodeApi')));
check('la CSP usa nonce y no unsafe-inline en scripts', ()=>{
  const h=view.view.webview.html;
  assert.ok(/script-src 'nonce-[a-z0-9]+';/.test(h), 'script-src debe ir con nonce');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(h), 'script-src no debe permitir unsafe-inline');
});
check('el selector ofrece todos los presets', ()=>{
  const h=view.view.webview.html;
  for(const v of ROW_PRESETS) assert.ok(h.includes('value="'+v+'"'), 'falta el preset '+v);
  assert.ok(h.includes('value="0"')&&h.includes('value="custom"'));
});

console.log('\nHandshake ready');
onMsg({command:'ready'});
check('al recibir ready se envia el limite actual', ()=>assert.ok(posted.some(m=>m.command==='setRowLimit'&&m.value===100)));
check('al recibir ready se vuelca la cola', ()=>assert.ok(posted.some(m=>m.command==='setData'&&m.rows.length===1)));
check('la cola queda vacia', ()=>assert.strictEqual(view.pending,null));

console.log('\nMensajes del webview');
onMsg({command:'rowLimit', value:50, rerun:true});
check('el cambio de limite llega a la extension', ()=>assert.deepStrictEqual(limitCalls[0],[50,true]));
onMsg({command:'rerun'});
check('el boton reejecutar llega a la extension', ()=>assert.strictEqual(rerunCalls,1));

console.log('\nEstados');
view.setBusy('Ejecutando…');
check('estado ocupado', ()=>assert.ok(posted.some(m=>m.command==='busy')));
view.setError('ORA-00942');
check('estado de error limpia las filas', ()=>assert.ok(posted.some(m=>m.command==='error')&&view.rows.length===0));
view.setData({rows:[{A:1},{A:2}],ms:5,connectionName:'dev',truncated:true});
const last=posted.filter(m=>m.command==='setData').pop();
check('marca truncated cuando se alcanza el limite', ()=>assert.strictEqual(last.meta.truncated,true));
check('meta incluye el limite vigente', ()=>assert.strictEqual(last.meta.limit,100));

console.log('\nreveal() resiliente');
const vs = require('vscode');

// caso del bug: el comando .focus no existe todavia
(async () => {
  const v2 = new ResultView({subscriptions:[]}, {});
  vs.__failCommands = ['OracleERPBIPublisherRunner.results.focus'];
  vs.__executed = [];
  let threw = null, ok;
  try { ok = await v2.reveal(); } catch (e) { threw = e; }
  check('reveal no lanza cuando falta el comando .focus', ()=>assert.strictEqual(threw, null));
  check('cae al contenedor del panel', ()=>assert.ok(vs.__executed.includes('workbench.view.extension.OracleERPBIPublisherRunnerPanel')));
  check('informa de que si pudo abrirlo', ()=>assert.strictEqual(ok, true));

  // caso extremo: los comandos existen pero fallan al ejecutarse
  const v3 = new ResultView({subscriptions:[]}, {});
  vs.__failCommands = ['OracleERPBIPublisherRunner.results.focus','workbench.view.extension.OracleERPBIPublisherRunnerPanel'];
  vs.__panels = [];
  threw = null;
  try { ok = await v3.reveal(); } catch (e) { threw = e; }
  check('reveal no lanza aunque fallen todas las vias', ()=>assert.strictEqual(threw, null));
  check('recurre al respaldo del editor', ()=>assert.strictEqual(ok, true));
  check('marca el panel como no disponible para no reintentarlo',
    ()=>assert.strictEqual(v3.panelContainerAvailable, false));

  // sin ningun webview todavia, los datos se encolan
  const v3b = new ResultView({subscriptions:[]}, {});
  v3b.setData({rows:[{A:1}],ms:1,connectionName:'x'});
  check('los datos se encolan mientras no hay webview',
    ()=>assert.ok(v3b.pending && v3b.pending.rows.length===1));
  check('isVisible es false sin ningun webview', ()=>assert.strictEqual(v3b.isVisible, false));
  vs.__failCommands = [];

  console.log('\nRespaldo en el editor cuando el panel no existe');
  // exactamente el caso del usuario: ninguno de los dos comandos registrado
  vs.__available = [];
  vs.__panels = [];
  const v4 = new ResultView({subscriptions:[]}, {});
  const ok4 = await v4.reveal();
  check('reveal tiene exito usando el respaldo', ()=>assert.strictEqual(ok4, true));
  check('se creo una pestana de editor', ()=>assert.strictEqual(vs.__panels.length, 1));
  check('el respaldo cuenta como visible', ()=>assert.strictEqual(v4.isVisible, true));
  check('no se reintenta la comprobacion', ()=>assert.strictEqual(v4.panelContainerAvailable, false));

  // y los datos llegan de verdad al webview de respaldo
  const p4 = vs.__panels[0];
  p4._onMsg({command:'ready'});
  v4.setData({rows:[{A:1},{A:2}],ms:7,connectionName:'dev'});
  check('los datos se pintan en el respaldo',
    ()=>assert.ok(p4._msgs.some(m=>m.command==='setData'&&m.rows.length===2)));
  check('el titulo refleja el numero de filas', ()=>assert.ok(p4.title.includes('2')));

  // un segundo reveal reutiliza la pestana en vez de abrir otra
  await v4.reveal();
  check('no se duplican pestanas', ()=>assert.strictEqual(vs.__panels.length, 1));

  // si mas tarde el panel inferior si aparece, el respaldo se cierra
  v4.resolveWebviewView({ webview:{ options:{}, cspSource:'', html:'',
    onDidReceiveMessage:noop2, postMessage:noop2 } });
  check('al aparecer el panel inferior se cierra el respaldo',
    ()=>assert.ok(p4.disposed && v4.panel === null));

  console.log('\nColocacion del respaldo');
  vs.__available = [];
  vs.__panels = [];
  vs.__executed = [];
  const v5 = new ResultView({subscriptions:[]}, {});
  await v5.reveal();
  check('el respaldo se mueve al grupo inferior',
    ()=>assert.ok(vs.__executed.includes('workbench.action.moveEditorToBelowGroup')));
  check('se crea enfocado para poder moverlo',
    ()=>assert.strictEqual(vs.__panels[0].viewColumn, vs.ViewColumn.Beside));

  // moveBelow manual
  vs.__executed = [];
  const moved = await v5.moveBelow();
  check('moveBelow reubica la pestana existente', ()=>assert.strictEqual(moved, true));
  check('moveBelow usa el mismo comando',
    ()=>assert.ok(vs.__executed.includes('workbench.action.moveEditorToBelowGroup')));

  const v6 = new ResultView({subscriptions:[]}, {});
  check('moveBelow sin pestana devuelve false', async ()=>assert.ok(true));
  assert.strictEqual(await v6.moveBelow(), false);

  vs.__available = ['OracleERPBIPublisherRunner.results.focus'];

  console.log(fail ? '\nFALLOS: ' + fail : '\n' + pass + ' pruebas correctas');
  process.exit(fail ? 1 : 0);
})();
