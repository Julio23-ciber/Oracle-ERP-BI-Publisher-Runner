const Module = require('module');
const path = require('path');
const assert = require('assert');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) {
  if (req === 'vscode') return path.resolve(__dirname, 'stub/vscode.js');
  return orig.call(this, req, ...a);
};
const vscode = require('vscode');
const ext = require('../extension.js');
const pkg = require('../package.json');

const ctx = {
  subscriptions: [],
  globalState: { _d:{}, get(k,d){return k in this._d?this._d[k]:d;}, update(k,v){this._d[k]=v;} },
  secrets: { store: async()=>{}, get: async()=>'pw', delete: async()=>{} },
};
ext.activate(ctx);

const declared = pkg.contributes.commands.map(c=>c.command).sort();
const wired = vscode.__registered.slice().sort();
let fail = 0;
const missing = declared.filter(c=>!wired.includes(c));
const extra   = wired.filter(c=>!declared.includes(c));
if (missing.length){ console.log('  FALLO comandos declarados sin implementar:', missing); fail++; }
else console.log('  ok    los', declared.length, 'comandos declarados estan implementados');
if (extra.length){ console.log('  FALLO comandos implementados sin declarar:', extra); fail++; }
else console.log('  ok    no hay comandos implementados sin declarar');

// menus y keybindings deben referenciar comandos existentes
const refs = new Set();
for (const g of Object.values(pkg.contributes.menus||{})) g.forEach(m=>refs.add(m.command));
(pkg.contributes.keybindings||[]).forEach(k=>refs.add(k.command));
const dangling = [...refs].filter(c=>!declared.includes(c));
if (dangling.length){ console.log('  FALLO menus/atajos apuntan a comandos inexistentes:', dangling); fail++; }
else console.log('  ok    menus y atajos apuntan a comandos existentes');

// las vistas del package.json deben existir en el contenedor declarado
const container = pkg.contributes.viewsContainers.activitybar[0].id;
if (!pkg.contributes.views[container]) { console.log('  FALLO el contenedor de vistas no tiene vistas'); fail++; }
else console.log('  ok    el contenedor de vistas', container, 'tiene', pkg.contributes.views[container].length, 'vistas');

// viewsWelcome debe apuntar a una vista real
const viewIds = pkg.contributes.views[container].map(v=>v.id);
const badWelcome = (pkg.contributes.viewsWelcome||[]).filter(w=>!viewIds.includes(w.view));
if (badWelcome.length){ console.log('  FALLO viewsWelcome apunta a vistas inexistentes'); fail++; }
else console.log('  ok    viewsWelcome apunta a vistas reales');

// la vista de resultados debe vivir en un contenedor de tipo panel
const panels = (pkg.contributes.viewsContainers.panel||[]).map(c=>c.id);
if(!panels.length){ console.log('  FALLO no hay contenedor de panel'); fail++; }
else {
  const pv = pkg.contributes.views[panels[0]]||[];
  const res = pv.find(v=>v.id==='OracleERPBIPublisherRunner.results');
  if(!res){ console.log('  FALLO la vista de resultados no esta en el panel'); fail++; }
  else if(res.type!=='webview'){ console.log('  FALLO la vista de resultados debe ser type webview'); fail++; }
  else console.log('  ok    resultados en el panel inferior como webview');
}
// las vistas contribuidas deben tener activationEvents o auto-activacion
const needed = ['onView:OracleERPBIPublisherRunner.results'];
const miss = needed.filter(a=>!pkg.activationEvents.includes(a));
if(miss.length){ console.log('  FALLO faltan activationEvents:', miss); fail++; }
else console.log('  ok    activationEvents cubren la vista del panel');

console.log(fail ? '\nFALLOS: '+fail : '\nCableado correcto');
process.exit(fail?1:0);
