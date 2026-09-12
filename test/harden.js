'use strict';

/**
 * ORA-40478: valor de salida demasiado grande (maximo: 4000).
 *
 * JSON_OBJECT y JSON_ARRAYAGG devuelven VARCHAR2(4000) si no se les pide otra
 * cosa, asi que una sola fila ancha (SELECT * sobre una tabla con muchas
 * columnas, tipico en Fusion) hace fallar la consulta. Aqui se comprueba que
 * la envoltura propia y el SQL escrito a mano por el usuario acaban ambos con
 * RETURNING CLOB en los dos niveles.
 */

const assert = require('assert');
const { hardenJsonReturning, buildDataModel } = require('../src/dataModel');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FALLO ${name}\n        ${e.message}`); fail++; }
}

console.log('\nRETURNING CLOB en el SQL del usuario');

check('anade CLOB en los dos niveles', () => {
    assert.strictEqual(
        hardenJsonReturning('SELECT JSON_ARRAYAGG(JSON_OBJECT(*)) AS R FROM T'),
        'SELECT JSON_ARRAYAGG(JSON_OBJECT(* RETURNING CLOB) RETURNING CLOB) AS R FROM T'
    );
});

check('completa el nivel de fila que faltaba', () => {
    // el caso real: SQL de una version anterior pegado en el editor
    const out = hardenJsonReturning(
        'SELECT JSON_ARRAYAGG(JSON_OBJECT(*) RETURNING CLOB) AS RESULT FROM (SELECT * FROM HZ_PARTY_SITES)');
    assert.ok(/JSON_OBJECT\(\* RETURNING CLOB\)/.test(out));
    assert.strictEqual((out.match(/RETURNING CLOB/g) || []).length, 2);
});

check('no duplica lo que ya esta bien', () => {
    const sql = 'SELECT JSON_ARRAYAGG(JSON_OBJECT(* RETURNING CLOB) RETURNING CLOB) AS R FROM T';
    assert.strictEqual(hardenJsonReturning(sql), sql);
});

check('respeta un RETURNING explicito del usuario', () => {
    const sql = 'SELECT JSON_ARRAYAGG(x RETURNING VARCHAR2(32767)) FROM T';
    assert.strictEqual(hardenJsonReturning(sql), sql);
});

check('RETURNING va despues de ORDER BY', () => {
    assert.strictEqual(
        hardenJsonReturning('SELECT JSON_ARRAYAGG(JSON_OBJECT(*) ORDER BY 1) FROM T'),
        'SELECT JSON_ARRAYAGG(JSON_OBJECT(* RETURNING CLOB) ORDER BY 1 RETURNING CLOB) FROM T'
    );
});

check('un SQL normal no se toca', () => {
    const sql = 'SELECT * FROM HZ_PARTY_SITES';
    assert.strictEqual(hardenJsonReturning(sql), sql);
});

check('varios agregados en la misma consulta', () => {
    const out = hardenJsonReturning(
        'SELECT JSON_ARRAYAGG(JSON_OBJECT(*)) A, JSON_ARRAYAGG(JSON_OBJECT(*)) B FROM T');
    assert.strictEqual((out.match(/JSON_ARRAYAGG\(JSON_OBJECT\(\* RETURNING CLOB\) RETURNING CLOB\)/g) || []).length, 2);
});

check('parentesis sin cerrar no cuelga ni corrompe', () => {
    const out = hardenJsonReturning('SELECT JSON_ARRAYAGG(JSON_OBJECT(*) FROM T');
    assert.ok(out.includes('JSON_OBJECT(* RETURNING CLOB)'));
});

console.log('\nEl data model aplica la correccion');

check('el SQL pegado por el usuario sale ya corregido', () => {
    const built = buildDataModel({
        name: 'FSR_WORK', folder: '/Custom/F', contentOnly: true, maxRows: 100,
        sql: 'SELECT JSON_ARRAYAGG(JSON_OBJECT(*) RETURNING CLOB) AS RESULT FROM (SELECT * FROM HZ_PARTY_SITES)',
    });
    assert.ok(/JSON_OBJECT\(\* RETURNING CLOB\)/.test(built.effectiveSql),
        'el JSON_OBJECT del usuario sigue sin CLOB');
});

check('tambien en modo xml, dentro del literal de DBMS_XMLGEN', () => {
    const built = buildDataModel({
        name: 'FSR_WORK', folder: '/Custom/F', contentOnly: true, maxRows: 100, wrapMode: 'xml',
        sql: 'SELECT JSON_ARRAYAGG(JSON_OBJECT(*)) AS RESULT FROM T',
    });
    assert.ok(built.effectiveSql.includes('DBMS_XMLGEN'));
    assert.ok(/JSON_OBJECT\(\* RETURNING CLOB\)/.test(built.effectiveSql));
});

console.log(`\n${pass} pruebas correctas, ${fail} fallos`);
process.exit(fail ? 1 : 0);
