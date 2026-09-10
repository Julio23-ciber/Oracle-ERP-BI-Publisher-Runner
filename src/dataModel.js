'use strict';

/**
 * Construccion de paquetes de Data Model (.xdmz) para Oracle BI Publisher.
 *
 * Las plantillas reproducen exactamente lo que emite Oracle Analytics
 * Publisher, incluidas sus rarezas: el namespace xsd con CUATRO "w" y el orden
 * de los bloques vacios. Verificado byte a byte contra paquetes descargados de
 * un pod real con downloadObject.
 */

const { createZip } = require('./zip');

const ROWS_PARAM = 'P_MAX_ROWS';

/**
 * Encuentra los bind variables (:NOMBRE) de una consulta.
 *
 * Antes de buscar hay que neutralizar comentarios y literales, o un
 * `WHERE NOTA = 'ver :P_ID'` daria un parametro fantasma. Se sustituyen por
 * huecos del mismo tipo en vez de borrarlos, para no pegar tokens vecinos.
 *
 * No confunde:
 *   ::TIPO        cast de otros dialectos
 *   v := 1        asignacion PL/SQL (tras ':' exige una letra)
 *   'texto :X'    literal
 *   -- :X         comentario de linea
 *   comentario de bloque
 */
function findBindParameters(sql) {
    const cleaned = String(sql)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n\r]*/g, ' ')
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/"(?:[^"]|"")*"/g, '""');

    const names = [];
    const re = /(?:^|[^:\w])(:)([A-Za-z][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const name = m[2].toUpperCase();
        if (name !== ROWS_PARAM && !names.includes(name)) names.push(name);
        // retroceder uno: ':A=:B' necesita que el segundo bind se vea
        re.lastIndex = m.index + m[0].length - 1;
    }
    return names;
}

/** Tipo XSD razonable segun el valor introducido. */
function inferDataType(value) {
    const s = String(value ?? '').trim();
    if (s === '') return 'xsd:string';
    if (/^-?\d+$/.test(s)) return 'xsd:integer';
    if (/^-?\d*\.\d+$/.test(s)) return 'xsd:double';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'xsd:string';   // BIP maneja fechas como texto
    return 'xsd:string';
}

function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Limita las filas con un subselect y ROWNUM.
 *
 * ROWNUM en vez de FETCH FIRST a proposito: funciona en cualquier version de
 * Oracle y compone con cualquier consulta interior, incluso si ya trae su
 * propio ORDER BY o su propia clausula de limitacion.
 */
function applyRowLimit(sql, maxRows, useParam) {
    const clean = sql.trim().replace(/;+\s*$/, '');
    if (useParam) {
        return {
            sql: `SELECT * FROM (\n${clean}\n) WHERE ROWNUM <= :${ROWS_PARAM}`,
            parameters: [{
                name: ROWS_PARAM,
                dataType: 'xsd:integer',
                defaultValue: maxRows || 100,
                label: 'Maximo de filas',
            }],
        };
    }
    if (maxRows && maxRows > 0) {
        return {
            sql: `SELECT * FROM (\n${clean}\n) WHERE ROWNUM <= ${parseInt(maxRows, 10)}`,
            parameters: [],
        };
    }
    return { sql: clean, parameters: [] };
}

/**
 * Envuelve el SQL para que devuelva UNA sola columna RESULT.
 *
 * El Data Engine solo emite los elementos declarados en <output>, asi que con
 * un SELECT * (columnas desconocidas de antemano) las filas saldrian vacias.
 * Envolviendo, todo el conjunto de resultados viaja dentro de un unico
 * elemento y no hay que declarar nada.
 */
function wrapSql(sql, mode, bindNames = []) {
    const clean = sql.trim().replace(/;+\s*$/, '');
    if (mode === 'none') return { sql: clean, columns: null };

    if (mode === 'json') {
        return {
            sql: `SELECT JSON_ARRAYAGG(JSON_OBJECT(*) RETURNING CLOB) AS RESULT\nFROM (\n${clean}\n)`,
            columns: [{ name: 'RESULT', dataType: 'xsd:string' }],
        };
    }

    if (mode === 'xml') {
        // DBMS_XMLGEN recibe el SQL como literal: hay que duplicar comillas y,
        // sobre todo, sacar TODOS los binds fuera del literal — dentro de las
        // comillas BIP no los resolveria y llegarian a Oracle como texto.
        let escaped = clean.replace(/'/g, "''");
        for (const name of [...bindNames, ROWS_PARAM]) {
            escaped = escaped.replace(
                new RegExp(`:${name}\\b`, 'gi'),
                `' || :${name} || '`
            );
        }
        return {
            sql: `SELECT DBMS_XMLGEN.GETXML('${escaped}') AS RESULT FROM DUAL`,
            columns: [{ name: 'RESULT', dataType: 'xsd:string' }],
        };
    }

    throw new Error(`Modo de envoltura desconocido: ${mode}`);
}

function normalizeElementName(raw) {
    let name = String(raw).trim().replace(/[^A-Za-z0-9_]/g, '_');
    if (!name || !/^[A-Za-z]/.test(name)) name = '_' + name;
    return name.toUpperCase();
}

function buildElements(columns) {
    return columns.map((col, i) => {
        const name = normalizeElementName(col.name);
        return `               <element name="${name}" value="${xmlEscape(col.name)}"` +
            ` label="${name}" dataType="${col.dataType || 'xsd:string'}"` +
            ` breakOrder="" fieldOrder="${i + 1}"/>`;
    }).join('\n');
}

function buildParameters(params) {
    if (!params || !params.length) return '<parameters/>';
    const inner = params.map((p) =>
        `      <parameter name="${xmlEscape(p.name)}" dataType="${p.dataType || 'xsd:string'}"` +
        ` defaultValue="${xmlEscape(p.defaultValue ?? '')}" rowPlacement="1">\n` +
        `         <input label="${xmlEscape(p.label || p.name)}"/>\n` +
        `      </parameter>`
    ).join('\n');
    return `<parameters>\n${inner}\n   </parameters>`;
}

/** Genera el contenido de _datamodel.xdm. */
function buildXdm({ sql, columns, dataSource, parameters, dataSetName = 'T1' }) {
    return `<?xml version = '1.0' encoding = 'utf-8'?>
<dataModel xmlns="http://xmlns.oracle.com/oxp/xmlp" version="2.1" xmlns:xdm="http://xmlns.oracle.com/oxp/xmlp" xmlns:xsd="http://wwww.w3.org/2001/XMLSchema" defaultDataSourceRef="Oracle BI EE">
   <dataProperties>
      <property name="include_parameters" value="true"/>
      <property name="include_null_Element" value="false"/>
      <property name="include_rowsettag" value="false"/>
      <property name="exclude_tags_for_lob" value="false"/>
      <property name="EXCLUDE_LINE_FEED_AND_CARRIAGE_RETURN_FOR_LOB" value="false"/>
      <property name="enable_sqlid_logging" value="true"/>
      <property name="xml_tag_case" value="upper"/>
      <property name="generate_output_format" value="xml"/>
      <property name="enforce_validation_status" value="true"/>
      <property name="optimize_query_executions" value="false"/>
      <property name="enable_xml_chunks" value=""/>
      <property name="sql_monitor_report_generated" value="false"/>
   </dataProperties>
   <dataSets>
      <dataSet name="${dataSetName}" type="complex">
         <sql dataSourceRef="${xmlEscape(dataSource)}">
            <![CDATA[${sql}
]]>
         </sql>
      </dataSet>
   </dataSets>
   <output rootName="DATA_DS" uniqueRowName="false">
      <nodeList name="data-structure">
         <dataStructure tagName="DATA_DS">
            <group name="G_1" label="G_1" source="${dataSetName}">
${buildElements(columns)}
            </group>
         </dataStructure>
      </nodeList>
   </output>
   <eventTriggers/>
   <lexicals/>
   ${buildParameters(parameters)}
   <valueSets/>
   <bursting/>
   <validations>
      <validation>N</validation>
   </validations>
   <display>
      <layouts>
         <layout name="${dataSetName}" left="280px" top="0px"/>
         <layout name="DATA_DS" left="0px" top="34px"/>
      </layouts>
      <groupLinks/>
   </display>
</dataModel>
`;
}

function buildMetadata(name, catalogPath, description = '') {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<metadata>
  <entries>
    <entry>
      <key><![CDATA[bip:DisplayName]]></key>
      <value><![CDATA[${name}]]></value>
    </entry>
    <entry>
      <key><![CDATA[DESCRIPTION]]></key>
      <value><![CDATA[${description}]]></value>
    </entry>
    <entry>
      <key><![CDATA[propertyMap]]></key>
      <value><![CDATA[1]]></value>
    </entry>
    <entry>
      <key><![CDATA[path]]></key>
      <value><![CDATA[${encodeURIComponent(catalogPath)}]]></value>
    </entry>
  </entries>
</metadata>`;
}

function buildSecurity(catalogPath) {
    const p = xmlEscape(catalogPath);
    const full = 'oracle.bi.publisher.fullControl,;&#x9; ';
    const read = 'oracle.bi.publisher.read,;&#x9; oracle.bi.publisher.traverse,;&#x9; ';
    const policy = (role, display, perms) =>
        `   <policy rolename="${role}" roleGUID="${role}" roleDisplayName="${display}">
      <folderPermission>
         <allow path="${p}" recursive="false" permissions="${perms}"/>
      </folderPermission>
   </policy>`;
    return `<?xml version = '1.0' encoding = 'UTF-8'?>
<security>
${policy('BIAuthor', 'BI Author Role', full)}
${policy('BIAdministrator', 'BI Administrator Role', full)}
${policy('BIConsumer', 'BI Consumer Role', read)}
</security>
`;
}

function buildSample(columns) {
    const rows = columns
        .map((c) => `<${normalizeElementName(c.name)}></${normalizeElementName(c.name)}>`)
        .join('\n');
    return `<?xml version = '1.0' encoding = 'utf-8'?>
<!--Generated by Oracle Analytics Publisher -Dataengine-->
<DATA_DS>
<G_1>
${rows}
</G_1>
</DATA_DS>
`;
}

/**
 * Prepara un data model completo a partir del SQL del usuario.
 *
 * contentOnly=true devuelve solo _datamodel.xdm, que es lo que conviene mandar
 * a updateObject: no toca permisos ni display name del objeto existente.
 */
function buildDataModel(opts) {
    const {
        name,
        folder,
        sql: userSql,
        dataSource = 'ApplicationDB_FSCM',
        wrapMode = 'json',
        maxRows = 100,
        useRowsParam = false,
        columns: explicitColumns = null,
        description = '',
        contentOnly = false,
        bindParameters = [],   // [{ name, value }] de los :BINDS del usuario
    } = opts;

    const catalogPath = `${folder.replace(/\/+$/, '')}/${name}.xdm`;

    const bindNames = bindParameters.map((p) => p.name);
    const limited = applyRowLimit(userSql, maxRows, useRowsParam);
    const wrapped = wrapSql(limited.sql, wrapMode, bindNames);
    const columns = wrapped.columns || explicitColumns || [{ name: '1', dataType: 'xsd:double' }];

    // los binds del usuario primero; el limite de filas es nuestro y va al final
    const parameters = [
        ...bindParameters.map((p) => ({
            name: p.name,
            dataType: p.dataType || inferDataType(p.value),
            defaultValue: p.value ?? '',
            label: p.label || p.name,
        })),
        ...limited.parameters,
    ];

    const xdm = buildXdm({
        sql: wrapped.sql,
        columns,
        dataSource,
        parameters,
    });

    const files = { '_datamodel.xdm': xdm, 'sample.xml': buildSample(columns) };
    if (!contentOnly) {
        files['~metadata.meta'] = buildMetadata(name, catalogPath, description);
        files['~security.sec'] = buildSecurity(catalogPath);
    }

    return {
        catalogPath,
        xdm,
        effectiveSql: wrapped.sql,
        parameters,
        bindNames,
        zip: createZip(files),
        content: Buffer.from(xdm, 'utf8'),
    };
}

module.exports = {
    ROWS_PARAM,
    findBindParameters,
    inferDataType,
    buildDataModel,
    buildXdm,
    applyRowLimit,
    wrapSql,
    xmlEscape,
};
