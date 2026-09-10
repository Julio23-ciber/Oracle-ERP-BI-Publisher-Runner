const assert=require('assert');
const dm=require('../src/dataModel');
const {readZip}=require('../src/zip');
let pass=0, fail=0;
const check=(n,f)=>{ try{ f(); console.log('  ok    '+n); pass++; }catch(e){ console.log('  FALLO '+n+'\n        '+e.message); fail++; } };

console.log('\nDeteccion de bind variables');
const SQL = `SELECT * 
FROM PER_ALL_PEOPLE_F PAPF
WHERE 1 = 1 
    AND PAPF.PERSON_ID = :P_ID`;
check('caso del usuario', ()=>assert.deepStrictEqual(dm.findBindParameters(SQL), ['P_ID']));
check('varios binds, sin duplicar',
  ()=>assert.deepStrictEqual(dm.findBindParameters('WHERE a=:A AND b=:B AND c=:A'), ['A','B']));
check('normaliza a mayusculas',
  ()=>assert.deepStrictEqual(dm.findBindParameters('WHERE x = :p_id'), ['P_ID']));
check('ignora literales',
  ()=>assert.deepStrictEqual(dm.findBindParameters("WHERE n = 'texto :FALSO' AND x = :REAL"), ['REAL']));
check('ignora comillas escapadas dentro del literal',
  ()=>assert.deepStrictEqual(dm.findBindParameters("WHERE n = 'it''s :FALSO' AND x = :REAL"), ['REAL']));
check('ignora comentarios de linea',
  ()=>assert.deepStrictEqual(dm.findBindParameters('-- filtro :FALSO\nWHERE x = :REAL'), ['REAL']));
check('ignora comentarios de bloque',
  ()=>assert.deepStrictEqual(dm.findBindParameters('/* :FALSO\n :TAMPOCO */ WHERE x = :REAL'), ['REAL']));
check('ignora identificadores entrecomillados',
  ()=>assert.deepStrictEqual(dm.findBindParameters('SELECT "col :FALSO" FROM t WHERE x=:REAL'), ['REAL']));
check('ignora el cast :: de otros dialectos',
  ()=>assert.deepStrictEqual(dm.findBindParameters('SELECT x::text FROM t WHERE y = :REAL'), ['REAL']));
check('ignora la asignacion := de PL/SQL',
  ()=>assert.deepStrictEqual(dm.findBindParameters('BEGIN v := 1; END; -- x'), []));
check('binds consecutivos',
  ()=>assert.deepStrictEqual(dm.findBindParameters('WHERE a BETWEEN :DESDE AND :HASTA'), ['DESDE','HASTA']));
check('excluye nuestro P_MAX_ROWS',
  ()=>assert.deepStrictEqual(dm.findBindParameters('WHERE ROWNUM <= :P_MAX_ROWS AND x = :MIO'), ['MIO']));
check('sin binds devuelve lista vacia',
  ()=>assert.deepStrictEqual(dm.findBindParameters('SELECT 1 FROM DUAL'), []));

console.log('\nTipos inferidos');
check('entero', ()=>assert.strictEqual(dm.inferDataType('300000004285099'), 'xsd:integer'));
check('negativo', ()=>assert.strictEqual(dm.inferDataType('-42'), 'xsd:integer'));
check('decimal', ()=>assert.strictEqual(dm.inferDataType('12.5'), 'xsd:double'));
check('texto', ()=>assert.strictEqual(dm.inferDataType('ACME'), 'xsd:string'));
check('vacio', ()=>assert.strictEqual(dm.inferDataType(''), 'xsd:string'));

console.log('\nDeclaracion en el .xdm (wrap json)');
const b = dm.buildDataModel({ name:'FSR_WORK', folder:'/Custom/F', sql:SQL, maxRows:100,
  contentOnly:true, bindParameters:[{name:'P_ID', value:'300000004285099'}] });
const xdm = readZip(b.zip)['_datamodel.xdm'].toString();
check('el parametro se declara',
  ()=>assert.ok(/<parameter name="P_ID" dataType="xsd:integer" defaultValue="300000004285099"/.test(xdm)));
check('include_parameters sigue activo',
  ()=>assert.ok(xdm.includes('<property name="include_parameters" value="true"/>')));
check('el bind queda intacto dentro del SQL',
  ()=>assert.ok(b.effectiveSql.includes('PAPF.PERSON_ID = :P_ID')));
check('el bind NO se rompe al aplicar el limite de filas',
  ()=>assert.ok(/:P_ID[\s\S]*ROWNUM <= 100/.test(b.effectiveSql)));

console.log('\nDeclaracion con el limite como parametro');
const b2 = dm.buildDataModel({ name:'X', folder:'/Custom/F', sql:SQL, maxRows:50,
  useRowsParam:true, contentOnly:true, bindParameters:[{name:'P_ID', value:'1'}] });
check('conviven el bind del usuario y P_MAX_ROWS',
  ()=>assert.deepStrictEqual(b2.parameters.map(p=>p.name), ['P_ID','P_MAX_ROWS']));

console.log('\nModo xml: los binds salen del literal');
const b3 = dm.buildDataModel({ name:'X', folder:'/Custom/F', sql:SQL, wrapMode:'xml',
  maxRows:100, contentOnly:true, bindParameters:[{name:'P_ID', value:'1'}] });
check('el bind se concatena fuera de las comillas',
  ()=>assert.ok(b3.effectiveSql.includes("' || :P_ID || '")));
check('no queda ningun bind dentro del literal', ()=>{
  const lit = b3.effectiveSql.match(/GETXML\('([\s\S]*)'\) AS RESULT/)[1];
  // dentro del literal solo pueden aparecer los binds ya extraidos por concatenacion
  const dentro = lit.split(/'\s*\|\|\s*:\w+\s*\|\|\s*'/).join(' ');
  assert.ok(!/:[A-Za-z]/.test(dentro), 'quedo un bind sin extraer: '+dentro);
});
check('funciona con minusculas en el SQL', ()=>{
  const b4 = dm.buildDataModel({ name:'X', folder:'/Custom/F', sql:'select * from t where id = :p_id',
    wrapMode:'xml', maxRows:0, contentOnly:true, bindParameters:[{name:'P_ID', value:'1'}] });
  assert.ok(/\|\| :p_id \|\|/i.test(b4.effectiveSql));
});

console.log(fail? '\nFALLOS: '+fail : '\n'+pass+' pruebas correctas');
process.exit(fail?1:0);
