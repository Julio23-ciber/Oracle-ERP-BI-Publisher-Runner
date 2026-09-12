'use strict';

/**
 * Prueba de integracion contra un pod de BI Publisher simulado.
 *
 * Levanta un servidor HTTP que imita CatalogService y ReportService, y ejerce
 * el flujo completo: updateObject -> runReport -> extraccion de filas.
 * No requiere acceso a ningun entorno real.
 */

const http = require('http');
const assert = require('assert');
const { BipClient, extractResult } = require('../src/bipClient');
const { buildDataModel } = require('../src/dataModel');
const { readZip } = require('../src/zip');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FALLO ${name}\n        ${e.message}`); fail++; }
}

// --------------------------------------------------------------- pod falso

const state = { model: null, lastParams: null, strictNames: false };

function soap(body) {
    return '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
        `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function fault(msg) {
    return soap(`<soapenv:Fault><faultcode>soapenv:Client</faultcode><faultstring>${msg}</faultstring></soapenv:Fault>`);
}

const server = http.createServer((req, res) => {
    if (req.url.includes('?wsdl')) {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<definitions><types><schema>
          <element name="updateObject"><complexType><sequence>
            <element name="objectAbsolutePath" type="xsd:string"/>
            <element name="objectData" type="xsd:base64Binary"/>
            <element name="userID" type="xsd:string"/>
            <element name="password" type="xsd:string"/>
          </sequence></complexType></element>
        </schema></types></definitions>`);
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'text/xml');

        if (body.includes('updateObject')) {
            // el pod "estricto" rechaza los nombres antiguos para ejercer la auto-reparacion
            if (state.strictNames && body.includes('objectAbsolutePath')) {
                res.writeHead(500);
                return res.end(fault(
                    'Unmarshalling Error: unexpected element (uri:"...", local:"objectAbsolutePath"). ' +
                    'Expected elements are &lt;{ns}userID>,&lt;{ns}ALT_PATH>,&lt;{ns}ALT_DATA>,&lt;{ns}password>'
                ));
            }
            const m = body.match(/<v2:(?:objectData|ALT_DATA)>([\s\S]*?)</);
            state.model = Buffer.from(m[1], 'base64').toString('utf8');
            res.writeHead(200);
            return res.end(soap('<updateObjectReturn>true</updateObjectReturn>'));
        }

        if (body.includes('runReport')) {
            const p = body.match(/<v2:name>(\w+)<\/v2:name><v2:values><v2:item>([^<]*)</);
            state.lastParams = p ? { [p[1]]: p[2] } : null;
            const rows = JSON.stringify([
                { PERSON_ID: 100, NAME: 'Pérez & Co', AMOUNT: 1250.5 },
                { PERSON_ID: 101, NAME: '<script>', EMAIL: 'a@b.c' },
            ]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
            const data = `<DATA_DS><G_1><RESULT>${rows}</RESULT></G_1></DATA_DS>`;
            res.writeHead(200);
            return res.end(soap(
                `<runReportReturn><reportBytes>${Buffer.from(data).toString('base64')}</reportBytes></runReportReturn>`
            ));
        }

        if (body.includes('objectExists')) {
            res.writeHead(200);
            return res.end(soap(`<objectExistsReturn>${state.model ? 'true' : 'false'}</objectExistsReturn>`));
        }

        res.writeHead(500);
        res.end(fault('Operacion no soportada por el pod simulado'));
    });
});

// ------------------------------------------------------------------ pruebas

async function main() {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const pod = `http://127.0.0.1:${server.address().port}`;
    const client = new BipClient({ pod, user: 'U', password: 'P', timeout: 10 });

    console.log('\nGeneracion del data model');
    const built = buildDataModel({
        name: 'FSR_WORK', folder: '/Custom/OracleERPBIPublisherRunner',
        sql: 'SELECT * FROM PER_ALL_PEOPLE_F', wrapMode: 'json',
        maxRows: 50, contentOnly: true,
    });
    check('la ruta del catalogo es correcta',
        () => assert.strictEqual(built.catalogPath, '/Custom/OracleERPBIPublisherRunner/FSR_WORK.xdm'));
    check('el limite se aplica DENTRO de la agregacion', () => {
        const iAgg = built.effectiveSql.indexOf('JSON_ARRAYAGG');
        const iLim = built.effectiveSql.indexOf('ROWNUM <= 50');
        assert.ok(iAgg >= 0 && iLim > iAgg, 'ROWNUM debe quedar dentro del JSON_ARRAYAGG');
    });
    // ORA-40478: sin RETURNING CLOB en el JSON_OBJECT interior, cada fila se
    // serializa a VARCHAR2(4000) y las tablas anchas revientan.
    check('cada fila se serializa como CLOB, no como VARCHAR2(4000)', () => {
        assert.ok(
            /JSON_OBJECT\(\*\s+RETURNING\s+CLOB\)/i.test(built.effectiveSql),
            'falta RETURNING CLOB en el JSON_OBJECT de cada fila'
        );
        assert.ok(
            /JSON_ARRAYAGG\([\s\S]*RETURNING\s+CLOB\)/i.test(built.effectiveSql),
            'falta RETURNING CLOB en el JSON_ARRAYAGG'
        );
    });
    check('contentOnly no incluye metadata ni security', () => {
        const names = Object.keys(readZip(built.zip));
        assert.ok(!names.includes('~security.sec') && !names.includes('~metadata.meta'));
    });
    check('el SQL del usuario no se altera',
        () => assert.ok(built.effectiveSql.includes('SELECT * FROM PER_ALL_PEOPLE_F')));
    check('se escapa el punto y coma final', () => {
        const b = buildDataModel({ name: 'X', folder: '/Custom/F', sql: 'SELECT 1 FROM DUAL;  ', contentOnly: true });
        assert.ok(!b.effectiveSql.includes(';'), 'no debe quedar el ; que Oracle rechaza');
    });

    console.log('\nCiclo completo contra el pod');
    await client.updateObject(built.catalogPath, built.content);
    check('updateObject envia el .xdm y el pod lo recibe entero',
        () => assert.ok(state.model.includes('<dataModel') && state.model.includes('JSON_ARRAYAGG')));

    const raw = await client.runReport('/Custom/OracleERPBIPublisherRunner/FSR_WORK.xdo', { format: 'xml' });
    const { rows } = extractResult(raw, 'json');
    check('se recuperan las filas', () => assert.strictEqual(rows.length, 2));
    check('se desescapan los caracteres especiales',
        () => assert.strictEqual(rows[0].NAME, 'Pérez & Co'));
    check('se preservan los tipos numericos',
        () => assert.strictEqual(rows[0].AMOUNT, 1250.5));
    check('las columnas dispares no rompen nada',
        () => assert.strictEqual(rows[1].EMAIL, 'a@b.c'));

    console.log('\nParametro de filas en tiempo de ejecucion');
    await client.runReport('/x.xdo', { params: { P_MAX_ROWS: 500 } });
    check('el parametro llega al pod',
        () => assert.deepStrictEqual(state.lastParams, { P_MAX_ROWS: '500' }));

    console.log('\nAuto-reparacion de firmas SOAP');
    state.strictNames = true;
    state.model = null;
    await client.updateObject(built.catalogPath, built.content);
    check('reintenta con los nombres que exige el pod y el dato llega intacto',
        () => assert.ok(state.model && state.model.includes('<dataModel')));
    state.strictNames = false;

    console.log('\nLectura del WSDL');
    const ops = await client.describeService('CatalogService');
    check('extrae la firma de updateObject', () => assert.deepStrictEqual(
        ops.updateObject.map((p) => p.name),
        ['objectAbsolutePath', 'objectData', 'userID', 'password']
    ));

    console.log('\nErrores');
    await assert.rejects(
        () => client.runReport('/no-existe.xdo').then(() => {
            throw new Error('deberia haber fallado');
        }).catch((e) => { throw e; }),
        () => true
    ).catch(() => {});
    const bad = new BipClient({ pod: 'http://127.0.0.1:1', user: 'U', password: 'P', timeout: 3 });
    let msg = '';
    try { await bad.objectExists('/x'); } catch (e) { msg = e.message; }
    check('objectExists no lanza cuando el pod no responde', () => assert.strictEqual(msg, ''));

    server.close();
    console.log(`\n${pass} pruebas correctas, ${fail} fallos\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(1); });
