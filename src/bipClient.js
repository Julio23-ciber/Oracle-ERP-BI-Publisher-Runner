'use strict';

/**
 * Cliente de los web services estandar de Oracle BI Publisher.
 *
 *   CatalogService v2  -> crear / actualizar / descargar objetos del catalogo
 *   ReportService v2   -> ejecutar reportes y recuperar los datos
 *
 * Sin dependencias: usa el fetch nativo de Node 18+, que es el que trae VS Code
 * a partir de la 1.80.
 */

const { xmlEscape } = require('./dataModel');

const NS = 'http://xmlns.oracle.com/oxp/service/v2';

class SoapFault extends Error {
    constructor(message, { service, operation, status, body } = {}) {
        super(message);
        this.name = 'SoapFault';
        this.service = service;
        this.operation = operation;
        this.status = status;
        this.body = body;
    }
}

class BipClient {
    constructor({ pod, user, password, timeout = 180, log = () => {} }) {
        this.pod = String(pod || '').replace(/\/+$/, '');
        this.user = user;
        this.password = password;
        this.timeout = timeout * 1000;
        this.log = log;
    }

    // ---------------------------------------------------------------- SOAP

    async _post(service, body, { operation = '' } = {}) {
        const envelope =
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
            `xmlns:v2="${NS}"><soap:Body>${body}</soap:Body></soap:Envelope>`;

        const url = `${this.pod}/xmlpserver/services/v2/${service}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        this.log(`--> ${operation || service} ${url}`);
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    SOAPAction: '',
                    Authorization:
                        'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64'),
                },
                body: envelope,
                signal: controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new SoapFault(
                    `Timeout tras ${this.timeout / 1000}s llamando a ${operation || service}. ` +
                    'Sube OracleERPBIPublisherRunner.requestTimeout o reduce el limite de filas.',
                    { service, operation }
                );
            }
            throw new SoapFault(
                `No se pudo contactar con ${url}: ${err.message}`,
                { service, operation }
            );
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        this.log(`<-- ${response.status} (${text.length} bytes)`);

        if (response.status === 401 || response.status === 403) {
            throw new SoapFault(
                'Credenciales rechazadas por el pod (HTTP ' + response.status + '). ' +
                'Revisa usuario/clave y que tenga el rol BI Author o BI Administrator.',
                { service, operation, status: response.status, body: text }
            );
        }
        if (response.status >= 400 || text.includes('<faultstring>')) {
            const m = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
            const detail = m ? decodeXmlEntities(m[1].trim()) : text.slice(0, 500);
            throw new SoapFault(detail, {
                service, operation, status: response.status, body: text,
            });
        }
        return text;
    }

    /**
     * Invoca una operacion con parametros con nombre.
     *
     * Si el pod rechaza los nombres con un unmarshalling error, releemos del
     * propio fault los elementos que esperaba y reintentamos una vez,
     * emparejando por ROL (ruta / datos / usuario / clave), nunca por posicion:
     * el fault los lista en un orden que no tiene por que ser el de la
     * secuencia. Asi el cliente sobrevive a las diferencias de firma entre
     * releases de BI Publisher.
     */
    async _call(service, operation, params) {
        const envelopeFor = (pairs) =>
            `<v2:${operation}>` +
            pairs.map(([n, v]) => `<v2:${n}>${v}</v2:${n}>`).join('') +
            `</v2:${operation}>`;

        try {
            return await this._post(service, envelopeFor(params), { operation });
        } catch (err) {
            if (!(err instanceof SoapFault) || !/Unmarshalling Error/i.test(err.message)) throw err;

            const expected = expectedFromFault(err.message);
            const given = params.map(([n]) => n);
            if (!expected.length || sameSet(expected, given)) throw err;

            const byRole = new Map(params.map(([n, v]) => [roleOf(n), v]));
            const retry = [];
            for (const name of expected) {
                const role = roleOf(name);
                if (!byRole.has(role)) {
                    throw new SoapFault(
                        `${err.message}\n\nEl pod espera [${expected.join(', ')}]; no se pudo ` +
                        `deducir el valor de "${name}". Usa el comando ` +
                        '"Inspeccionar firmas del CatalogService" y ajusta el cliente.',
                        { service, operation }
                    );
                }
                retry.push([name, byRole.get(role)]);
            }
            this.log(`[~] ${operation}: reintento [${given}] -> [${expected}]`);
            return this._post(service, envelopeFor(retry), { operation });
        }
    }

    // ------------------------------------------------------------ catalogo

    /**
     * Crea un objeto nuevo. Recibe la carpeta padre + nombre + tipo.
     * Tipos: xdmz (data model comprimido), xdoz (reporte comprimido).
     */
    async uploadObject(folder, name, zipped, objectType = 'xdmz') {
        return this._call('CatalogService', 'uploadObject', [
            ['reportObjectAbsolutePathURL', xmlEscape(folder)],
            ['objectName', xmlEscape(name)],
            ['objectType', objectType],
            ['objectZippedData', zipped.toString('base64')],
            ['userID', xmlEscape(this.user)],
            ['password', xmlEscape(this.password)],
        ]);
    }

    /**
     * Reemplaza el contenido de un objeto YA EXISTENTE.
     *
     * Firma confirmada contra Fusion:
     *   updateObject(objectAbsolutePath, objectData, userID, password)
     * Ojo: los nombres NO coinciden con los de uploadObject.
     *
     * Preserva GUID, permisos y suscripciones, asi que los reportes que
     * referencian este data model nunca pierden el vinculo.
     */
    async updateObject(catalogPath, data) {
        return this._call('CatalogService', 'updateObject', [
            ['objectAbsolutePath', xmlEscape(catalogPath)],
            ['objectData', data.toString('base64')],
            ['userID', xmlEscape(this.user)],
            ['password', xmlEscape(this.password)],
        ]);
    }

    async downloadObject(catalogPath) {
        const xml = await this._call('CatalogService', 'downloadObject', [
            ['reportObjectAbsolutePathURL', xmlEscape(catalogPath)],
            ['userID', xmlEscape(this.user)],
            ['password', xmlEscape(this.password)],
        ]);
        const m = xml.match(/<(?:\w+:)?downloadObjectReturn>([\s\S]*?)<\//);
        return m ? Buffer.from(m[1], 'base64') : null;
    }

    async objectExists(catalogPath) {
        try {
            const xml = await this._call('CatalogService', 'objectExists', [
                ['reportObjectAbsolutePathURL', xmlEscape(catalogPath)],
                ['userID', xmlEscape(this.user)],
                ['password', xmlEscape(this.password)],
            ]);
            const m = xml.match(/<(?:\w+:)?objectExistsReturn>([\s\S]*?)<\//);
            return m ? m[1].trim().toLowerCase() === 'true' : false;
        } catch {
            return false;
        }
    }

    async createFolder(parent, folderName) {
        return this._call('CatalogService', 'createFolder', [
            ['folderAbsolutePath', xmlEscape(parent)],
            ['folderName', xmlEscape(folderName)],
            ['userID', xmlEscape(this.user)],
            ['password', xmlEscape(this.password)],
        ]);
    }

    async deleteObject(catalogPath) {
        return this._call('CatalogService', 'deleteObject', [
            ['reportObjectAbsolutePathURL', xmlEscape(catalogPath)],
            ['userID', xmlEscape(this.user)],
            ['password', xmlEscape(this.password)],
        ]);
    }

    // ----------------------------------------------------------- ejecucion

    /**
     * Ejecuta un reporte y devuelve sus bytes.
     * Con format 'xml' el Data Engine devuelve los datos crudos del modelo.
     */
    async runReport(reportPath, { format = 'xml', params = null } = {}) {
        let paramXml = '';
        if (params && Object.keys(params).length) {
            const items = Object.entries(params).map(([k, v]) =>
                '<v2:item>' +
                `<v2:name>${xmlEscape(k)}</v2:name>` +
                `<v2:values><v2:item>${xmlEscape(v)}</v2:item></v2:values>` +
                '</v2:item>'
            ).join('');
            paramXml =
                '<v2:parameterNameValues><v2:listOfParamNameValues>' +
                items +
                '</v2:listOfParamNameValues></v2:parameterNameValues>';
        }

        const body =
            '<v2:runReport><v2:reportRequest>' +
            `<v2:attributeFormat>${format}</v2:attributeFormat>` +
            `<v2:reportAbsolutePath>${xmlEscape(reportPath)}</v2:reportAbsolutePath>` +
            paramXml +
            '<v2:sizeOfDataChunkDownload>-1</v2:sizeOfDataChunkDownload>' +
            '</v2:reportRequest>' +
            `<v2:userID>${xmlEscape(this.user)}</v2:userID>` +
            `<v2:password>${xmlEscape(this.password)}</v2:password>` +
            '</v2:runReport>';

        const xml = await this._post('ReportService', body, { operation: 'runReport' });
        const m = xml.match(/<(?:\w+:)?reportBytes>([\s\S]*?)<\//);
        return m ? Buffer.from(m[1], 'base64') : Buffer.from(xml, 'utf8');
    }

    /** Lee el WSDL y devuelve las firmas reales de cada operacion. */
    async describeService(service = 'CatalogService') {
        const url = `${this.pod}/xmlpserver/services/v2/${service}?wsdl`;
        const res = await fetch(url, {
            headers: {
                Authorization:
                    'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64'),
            },
        });
        if (!res.ok) throw new Error(`No se pudo leer el WSDL (HTTP ${res.status}): ${url}`);
        const wsdl = await res.text();

        const ops = {};
        const re = /<(?:\w+:)?element\s+name="(\w+)"[^>]*>\s*<(?:\w+:)?complexType>\s*<(?:\w+:)?sequence>([\s\S]*?)<\/(?:\w+:)?sequence>/g;
        let m;
        while ((m = re.exec(wsdl)) !== null) {
            const params = [...m[2].matchAll(/name="(\w+)"[^>]*type="([^"]+)"/g)]
                .map((p) => ({ name: p[1], type: p[2] }));
            if (params.length) ops[m[1]] = params;
        }
        return ops;
    }
}

// ------------------------------------------------------------------ helpers

function decodeXmlEntities(s) {
    return String(s)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');   // el ultimo, si no se re-decodifican los anteriores
}

/** Nombres que el servidor decia esperar, sacados del texto del fault. */
function expectedFromFault(message) {
    const m = message.match(/Expected elements are ([\s\S]+)$/);
    if (!m) return [];
    return [...m[1].matchAll(/\{[^}]*\}(\w+)/g)].map((x) => x[1]);
}

/** Clasifica un nombre de parametro SOAP en su rol semantico. */
function roleOf(paramName) {
    const n = paramName.toLowerCase();
    if (n.includes('pass')) return 'password';
    if (n.includes('user')) return 'user';
    if (n.includes('data')) return 'data';
    if (n.includes('type')) return 'type';
    if (n.includes('name')) return 'name';
    if (n.includes('path') || n.includes('url')) return 'path';
    return n;
}

function sameSet(a, b) {
    return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Extrae los datos utiles del XML que devuelve runReport.
 *
 * Forma esperada:  <DATA_DS><G_1><RESULT>...</RESULT></G_1></DATA_DS>
 * donde RESULT trae el conjunto de resultados completo gracias a wrapSql().
 */
function extractResult(payload, wrapMode = 'json') {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);

    const blocks = [...text.matchAll(/<RESULT>([\s\S]*?)<\/RESULT>/g)].map((m) => m[1]);
    if (!blocks.length) {
        // sin envoltura: convertir los grupos <G_1> en filas
        return { rows: parsePlainGroups(text), raw: text };
    }

    const raw = decodeXmlEntities(blocks.join('')).trim();
    if (!raw) return { rows: [], raw: text };

    if (wrapMode === 'json') {
        try {
            const parsed = JSON.parse(raw);
            return { rows: Array.isArray(parsed) ? parsed : [parsed], raw: text };
        } catch (e) {
            throw new Error(
                `RESULT no es JSON valido (${e.message}). ` +
                'Si tu base no soporta JSON_OBJECT(*) (necesita Oracle 19c+), ' +
                'cambia OracleERPBIPublisherRunner.wrapMode a "xml".\n\n' +
                raw.slice(0, 300)
            );
        }
    }
    return { rows: parsePlainGroups(raw), raw: text };
}

/** Convierte <G_1><COL>v</COL></G_1> repetido en un array de objetos. */
function parsePlainGroups(xml) {
    const rows = [];
    const groupRe = /<(G_\d+|ROW)>([\s\S]*?)<\/\1>/g;
    let g;
    while ((g = groupRe.exec(xml)) !== null) {
        const row = {};
        const fieldRe = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g;
        let f;
        while ((f = fieldRe.exec(g[2])) !== null) {
            row[f[1]] = decodeXmlEntities(f[2]);
        }
        if (Object.keys(row).length) rows.push(row);
    }
    return rows;
}

module.exports = { BipClient, SoapFault, extractResult, decodeXmlEntities };
